/**
 * What `kamado ui` remembers between runs: one file per user, `~/.config/kamado/ui-settings.json`,
 * with the settings of the screen that are the same everywhere (`global`) and those of each
 * project (`projects`, by the real path of its config file). RFC section 14.2.
 *
 * Why one file for all projects: the command that lists and removes the settings
 * (`kamado ui-settings`) must find the projects that are not open, and a file in each project
 * would be one more file in the repository that someone commits.
 *
 * Why a lock and a read just before each write: two `kamado ui` for two projects write the
 * same file. Each write reads the file again under the lock and changes only its own entry, so
 * that neither loses the other's settings. The file is replaced by a rename, so a reader never
 * sees half of one; it is readable by its owner only, as it holds the paths of projects.
 *
 * Why a broken file is put aside and a newer one is not: a file that is not JSON (or has the
 * wrong shape) is no use to anyone and would stop the screen from ever saving, so it is moved
 * to `ui-settings.json.<time>.bak` and a new one is begun. A file whose `version` is after this
 * one was written by a newer kamado that understands it: it is left alone (this one neither
 * reads its entries nor writes), so that an old kamado run once does not undo a new one's work.
 *
 * Why a field added to an entry does not raise `version`: a kamado that finds a higher version
 * does not use the file at all, so one new field would make every setting unusable by an older
 * kamado. The price is that an older kamado drops the field it does not know at its next save
 * (`sort`, `columns`); the settings are a convenience, and that is the smaller loss.
 *
 * Nothing here puts a path in a message that can reach the browser: the file is told by its
 * name, the way the rest of the screen's text is told without the directories of the machine.
 */
import { randomBytes } from 'node:crypto';
import {
	mkdir,
	open,
	readFile,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** The numbers of rows a page of the screen can show (RFC section 14.2). */
export const PAGE_SIZES = [100, 500, 1000, 5000] as const;

/** The languages of the screen; `auto` follows the browser. */
export const LOCALES = ['auto', 'en', 'ja'] as const;

/** A language setting. */
export type Locale = (typeof LOCALES)[number];

/** What is the same for every project. */
export interface GlobalSettings {
	readonly locale: Locale;
}

/** The longest key of a column a sort may name (a name of a metadata key is far shorter). */
export const MAX_SORT_KEY = 256;

/**
 * Whether `key` names a column of the screen: `url`, `inputPath`, `virtual` or
 * `meta:<key>` (RFC section 14.2).
 * @param key - A column's identifier
 * @example
 * ```ts
 * isSortKey('meta:title'); // true
 * isSortKey('title'); // false
 * ```
 */
export function isSortKey(key: string): boolean {
	return (
		key === 'url' ||
		key === 'inputPath' ||
		key === 'virtual' ||
		(key.startsWith('meta:') && key.length > 'meta:'.length && key.length <= MAX_SORT_KEY)
	);
}

/** The column the rows are ordered by, and which way. */
export interface SortSettings {
	/** The identifier of the column (see {@link isSortKey}). */
	readonly key: string;
	readonly desc: boolean;
}

/**
 * The narrowest and the widest a column is made, in pixels. The screen writes the same numbers
 * for itself, as it cannot import this module; `settings-columns.spec.ts` compares the two.
 */
export const MIN_COLUMN_WIDTH = 48;
export const MAX_COLUMN_WIDTH = 2000;

/**
 * The most columns a list of the settings names. Three lists of this many columns with ordinary
 * key names fit in the 64 KiB a change of the settings may be (`MAX_SETTINGS_BODY` of
 * `app.ts`); a limit above what the body can hold would never be reached.
 */
export const MAX_COLUMNS = 500;

/**
 * How the columns are laid out. Every field is left out when the screen has not set it: the
 * order of the columns, which are pinned (`pinned` left out is the default, the URL; an empty
 * list is every column unpinned) and the widths of the columns that are not the default width.
 * The columns are named as a sort names them (see {@link isSortKey}).
 */
export interface ColumnSettings {
	readonly order?: readonly string[];
	readonly pinned?: readonly string[];
	readonly widths?: Readonly<Record<string, number>>;
}

/** What is kept for one project. */
export interface ProjectSettings {
	/** When it was last saved (ISO 8601), or an empty string if the file did not say. */
	readonly updatedAt: string;
	/** Rows of a page of the screen: one of {@link PAGE_SIZES}. */
	readonly pageSize: number;
	/** The order of the rows; left out when the rows are in the order of the plan. */
	readonly sort?: SortSettings;
	/** The layout of the columns; left out when the screen has not changed it. */
	readonly columns?: ColumnSettings;
}

/** The content of the file. */
export interface SettingsFile {
	readonly version: 1;
	readonly global: GlobalSettings;
	readonly projects: Readonly<Record<string, ProjectSettings>>;
}

/** What the screen is told: its own project's entry (`null` before anything was saved). */
export interface SettingsView {
	readonly global: GlobalSettings;
	readonly project: ProjectSettings | null;
	/** Why the file is not used as it is (put aside, newer, unreadable), or `null`. */
	readonly warning: string | null;
}

/** A change to the settings, as the screen sends it. */
export interface SettingsPatch {
	readonly global?: { readonly locale?: Locale };
	readonly project?: {
		readonly pageSize?: number;
		/** `null` puts the rows back in the order of the plan. */
		readonly sort?: SortSettings | null;
		/** Replaces the layout of the columns as a whole; `null` puts the default back. */
		readonly columns?: ColumnSettings | null;
	};
}

/**
 * Why the settings were not saved when it is a matter of the file and not of the disk: the file
 * is `newer` than this kamado, or `locked` by another process for longer than is waited. The
 * message names the file, not its directory.
 * @example
 * ```ts
 * try {
 * 	await store.update({ project: { pageSize: 100 } });
 * } catch (error) {
 * 	if (error instanceof SettingsError && error.code === 'newer') {
 * 		// the file was written by a newer kamado: leave it
 * 	}
 * }
 * ```
 */
export class SettingsError extends Error {
	readonly code: 'newer' | 'locked';

	constructor(code: 'newer' | 'locked', message: string) {
		super(message);
		this.name = 'SettingsError';
		this.code = code;
	}
}

/** What reading the file found. */
export type ReadResult =
	| { readonly state: 'missing' }
	| { readonly state: 'ok'; readonly settings: SettingsFile }
	| { readonly state: 'newer'; readonly version: number }
	| { readonly state: 'broken'; readonly reason: string };

const VERSION = 1;
const DEFAULT_GLOBAL: GlobalSettings = { locale: 'auto' };
const DEFAULT_PAGE_SIZE = 500;
/** A lock that is older than this was left by a process that died. */
const STALE_LOCK_MS = 10_000;
const LOCK_WAIT_MS = 20;
const LOCK_ATTEMPTS = 150;

/**
 * Where the settings are kept: `~/.config/kamado/ui-settings.json`, or the file that
 * `KAMADO_UI_SETTINGS` names (for tests and for trying the command without touching the real
 * file). `XDG_CONFIG_HOME` is not read: the place is the one the documentation names.
 * @param env - The environment
 * @param home - The home directory
 * @example
 * ```ts
 * defaultSettingsFile({}, '/home/u'); // '/home/u/.config/kamado/ui-settings.json'
 * ```
 */
export function defaultSettingsFile(
	env: Readonly<Record<string, string | undefined>> = process.env,
	home: string = os.homedir(),
): string {
	const named = env.KAMADO_UI_SETTINGS;
	// Made absolute: a relative name would be a different file in every directory the command
	// is run in, and `ui-settings list` would not see what `ui` saved.
	return named === undefined || named === ''
		? path.join(home, '.config', 'kamado', 'ui-settings.json')
		: path.resolve(named);
}

/**
 * Whether a value is a plain object (not `null`, not an array).
 * @param value - Any value
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The global settings of a parsed value: what is allowed is kept, the rest is the default.
 * @param value - `global` of the file
 */
function sanitizeGlobal(value: unknown): GlobalSettings {
	const locale = isRecord(value) ? value.locale : undefined;
	return { locale: LOCALES.find((l) => l === locale) ?? DEFAULT_GLOBAL.locale };
}

/**
 * Sets an own data property. `projects[key] = value` with the key `__proto__` would set the
 * prototype of the object and not the entry, and the entry would not be written out again.
 * @param target - The object
 * @param key - The key, which may be any string
 * @param value - The value
 */
function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
	Object.defineProperty(target, key, {
		value,
		enumerable: true,
		writable: true,
		configurable: true,
	});
}

/**
 * Why an error is told to the screen: the code of an error of the disk (its message names the
 * path of the file, `EACCES: permission denied, open '<path>'`, and the screen is not told
 * paths), or the message of an error that does not name one.
 * @param error - What was thrown
 */
function reasonOf(error: unknown): string {
	if (error instanceof SettingsError) {
		return error.message;
	}
	const { code } = (error ?? {}) as NodeJS.ErrnoException;
	if (typeof code === 'string') {
		return code;
	}
	return error instanceof Error ? error.message : String(error);
}

/**
 * A sort from a parsed value: `undefined` when it is not one.
 * @param value - A `sort` of an entry or of a patch
 */
function readSort(value: unknown): SortSettings | undefined {
	if (!isRecord(value) || typeof value.key !== 'string' || !isSortKey(value.key)) {
		return undefined;
	}
	return { key: value.key, desc: value.desc === true };
}

/**
 * Whether a number is a width a column may have.
 * @param value - Any value
 */
function isWidth(value: unknown): value is number {
	return (
		typeof value === 'number' &&
		Number.isInteger(value) &&
		value >= MIN_COLUMN_WIDTH &&
		value <= MAX_COLUMN_WIDTH
	);
}

/**
 * The columns of a parsed value, for the file: what is allowed is kept, and the rest is
 * dropped (the screen never sends it, so it is a file that somebody edited). The change of the
 * screen is checked strictly by `parseColumns`; the two keep the same rules.
 * @param value - `columns` of an entry
 */
function readColumns(value: unknown): ColumnSettings | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const list = (items: unknown): string[] | undefined =>
		Array.isArray(items)
			? [
					...new Set(
						items.filter(
							(item): item is string => typeof item === 'string' && isSortKey(item),
						),
					),
				].slice(0, MAX_COLUMNS)
			: undefined;
	const order = list(value.order);
	const pinned = list(value.pinned);
	let widths: Record<string, number> | undefined;
	if (isRecord(value.widths)) {
		widths = {};
		for (const [key, width] of Object.entries(value.widths).slice(0, MAX_COLUMNS)) {
			if (isSortKey(key) && isWidth(width)) {
				setOwn(widths, key, width);
			}
		}
	}
	const columns: ColumnSettings = {
		...(order === undefined ? {} : { order }),
		...(pinned === undefined ? {} : { pinned }),
		...(widths === undefined ? {} : { widths }),
	};
	return Object.keys(columns).length === 0 ? undefined : columns;
}

/**
 * The settings of one project from a parsed value.
 * @param value - An entry of `projects`
 */
function sanitizeProject(value: Record<string, unknown>): ProjectSettings {
	const size = PAGE_SIZES.find((n) => n === value.pageSize);
	const sort = readSort(value.sort);
	const columns = readColumns(value.columns);
	return {
		updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
		pageSize: size ?? DEFAULT_PAGE_SIZE,
		...(sort === undefined ? {} : { sort }),
		...(columns === undefined ? {} : { columns }),
	};
}

/**
 * Reads the text of the file. A value that is not allowed becomes the default and a field that
 * is not known is dropped (so the file written next holds only what this version knows); text
 * that is not JSON, or a file whose top level has the wrong shape, is `broken`.
 * @param text - The content of the file
 * @example
 * ```ts
 * parseSettings('{"version":1}').state; // 'ok'
 * parseSettings('{').state; // 'broken'
 * ```
 */
export function parseSettings(text: string): Exclude<ReadResult, { state: 'missing' }> {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return {
			state: 'broken',
			reason: error instanceof Error ? error.message : String(error),
		};
	}
	if (!isRecord(value)) {
		return { state: 'broken', reason: 'the top level is not an object' };
	}
	const { version } = value;
	if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
		return { state: 'broken', reason: '"version" is not a whole number from 1' };
	}
	if (version > VERSION) {
		return { state: 'newer', version };
	}
	if (value.global !== undefined && !isRecord(value.global)) {
		return { state: 'broken', reason: '"global" is not an object' };
	}
	if (value.projects !== undefined && !isRecord(value.projects)) {
		return { state: 'broken', reason: '"projects" is not an object' };
	}
	const projects: Record<string, ProjectSettings> = {};
	for (const [key, entry] of Object.entries(value.projects ?? {})) {
		if (!isRecord(entry)) {
			// As a wrong `global` is: the shape is not this version's, and an entry that is dropped
			// without a word would be gone from the file at the next save.
			return { state: 'broken', reason: 'an entry of "projects" is not an object' };
		}
		setOwn(projects, key, sanitizeProject(entry));
	}
	return {
		state: 'ok',
		settings: { version: VERSION, global: sanitizeGlobal(value.global), projects },
	};
}

/**
 * Reads the file.
 * @param file - The settings file
 * @throws {Error} when the file exists and cannot be read (permissions, a directory)
 * @example
 * ```ts
 * const read = await readSettingsFile(defaultSettingsFile());
 * if (read.state === 'ok') {
 * 	console.log(Object.keys(read.settings.projects));
 * }
 * ```
 */
export async function readSettingsFile(file: string): Promise<ReadResult> {
	let text: string;
	try {
		text = await readFile(file, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return { state: 'missing' };
		}
		throw error;
	}
	return parseSettings(text);
}

/**
 * The columns of a change, checked: a list that is not a list of columns, one that names a column
 * twice or is longer than the limit, and a width out of range are refused. The file is read
 * leniently by `readColumns`; the two keep the same rules.
 * @param value - `columns` of the change
 * @throws {Error} naming what is not allowed
 */
function parseColumns(value: unknown): ColumnSettings | null {
	if (value === null) {
		return null;
	}
	if (!isRecord(value)) {
		throw new Error('"columns" is null or an object');
	}
	const list = (name: 'order' | 'pinned'): string[] | undefined => {
		const items = value[name];
		if (items === undefined) {
			return undefined;
		}
		if (
			!Array.isArray(items) ||
			items.length > MAX_COLUMNS ||
			!items.every((item) => typeof item === 'string' && isSortKey(item)) ||
			new Set(items).size !== items.length
		) {
			throw new Error(
				`"columns.${name}" is a list of at most ${MAX_COLUMNS} different columns: url, inputPath, virtual or meta:<key>`,
			);
		}
		return items as string[];
	};
	const order = list('order');
	const pinned = list('pinned');
	let widths: Record<string, number> | undefined;
	if (value.widths !== undefined) {
		const entries = isRecord(value.widths) ? Object.entries(value.widths) : undefined;
		if (
			entries === undefined ||
			entries.length > MAX_COLUMNS ||
			!entries.every(([key, width]) => isSortKey(key) && isWidth(width))
		) {
			throw new Error(
				`"columns.widths" maps at most ${MAX_COLUMNS} columns to a whole number of pixels from ${MIN_COLUMN_WIDTH} to ${MAX_COLUMN_WIDTH}`,
			);
		}
		widths = {};
		for (const [key, width] of entries) {
			setOwn(widths, key, width as number);
		}
	}
	return {
		...(order === undefined ? {} : { order }),
		...(pinned === undefined ? {} : { pinned }),
		...(widths === undefined ? {} : { widths }),
	};
}

/**
 * The change the screen sent, checked. What is not known is dropped; a value that is of a
 * known field and not allowed is refused (the screen never sends one).
 * @param value - The parsed body
 * @throws {Error} naming what is not allowed
 * @example
 * ```ts
 * parsePatch({ project: { pageSize: 100 } }); // { project: { pageSize: 100 } }
 * parsePatch({ project: { pageSize: 7 } }); // throws
 * ```
 */
export function parsePatch(value: unknown): SettingsPatch {
	if (!isRecord(value)) {
		throw new Error('the body is not an object');
	}
	const patch: {
		global?: { locale: Locale };
		project?: {
			pageSize?: number;
			sort?: SortSettings | null;
			columns?: ColumnSettings | null;
		};
	} = {};
	if (value.global !== undefined) {
		if (!isRecord(value.global)) {
			throw new Error('"global" is not an object');
		}
		const { locale } = value.global;
		if (locale !== undefined) {
			const known = LOCALES.find((l) => l === locale);
			if (known === undefined) {
				throw new Error(`"locale" is one of ${LOCALES.join(', ')}`);
			}
			patch.global = { locale: known };
		}
	}
	if (value.project !== undefined) {
		if (!isRecord(value.project)) {
			throw new Error('"project" is not an object');
		}
		const { pageSize, sort, columns } = value.project;
		const project: {
			pageSize?: number;
			sort?: SortSettings | null;
			columns?: ColumnSettings | null;
		} = {};
		if (pageSize !== undefined) {
			const known = PAGE_SIZES.find((n) => n === pageSize);
			if (known === undefined) {
				throw new Error(`"pageSize" is one of ${PAGE_SIZES.join(', ')}`);
			}
			project.pageSize = known;
		}
		if (sort !== undefined) {
			const known = sort === null ? null : readSort(sort);
			if (known === undefined) {
				throw new Error(
					'"sort" is null or { key, desc } of a column: url, inputPath, virtual or meta:<key>',
				);
			}
			if (isRecord(sort) && sort.desc !== undefined && typeof sort.desc !== 'boolean') {
				throw new Error('"sort.desc" is a boolean');
			}
			project.sort = known;
		}
		if (columns !== undefined) {
			project.columns = parseColumns(columns);
		}
		if (Object.keys(project).length > 0) {
			patch.project = project;
		}
	}
	return patch;
}

/**
 * Runs `run` while this process holds the lock of the file (a file made with `wx`, so that
 * only one process makes it). A lock older than {@link STALE_LOCK_MS} was left by a process
 * that died, or that was stopped for that long, and is taken over. The lock holds a name that
 * only its owner knows, and an owner removes the lock only if it still holds that name: one
 * that lost its lock to a takeover must not remove the lock of the process that took it.
 * Two processes that find the same stale lock at the same moment can still remove each
 * other's new one, which needs a crash (or a stop of ten seconds) first.
 * @param file - The settings file
 * @param run - What to do under the lock
 * @param wait - How often, and how long between, to try for a lock that is held (a few seconds
 * in all by default; a test shortens it)
 * @param wait.attempts
 * @param wait.pauseMs
 * @throws {SettingsError} when the lock is not got in that time
 * @example
 * ```ts
 * await withLock(file, async () => {
 * 	// read, change and write the file: no other kamado does it meanwhile
 * });
 * ```
 */
export async function withLock<T>(
	file: string,
	run: () => Promise<T>,
	wait: { readonly attempts?: number; readonly pauseMs?: number } = {},
): Promise<T> {
	const attempts = wait.attempts ?? LOCK_ATTEMPTS;
	const pauseMs = wait.pauseMs ?? LOCK_WAIT_MS;
	await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const lock = `${file}.lock`;
	const owner = randomBytes(8).toString('hex');
	let handle;
	for (let attempt = 0; handle === undefined; attempt++) {
		try {
			handle = await open(lock, 'wx', 0o600);
			try {
				await handle.writeFile(owner);
			} catch (error) {
				// A lock with no owner's name in it (the disk is full) would block every other
				// kamado until it is old enough to be taken over.
				await handle.close();
				await rm(lock, { force: true });
				throw error;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
				throw error;
			}
			const info = await stat(lock).catch(() => null);
			if (info !== null && Date.now() - info.mtimeMs > STALE_LOCK_MS) {
				await unlink(lock).catch(() => {});
			} else if (attempt >= attempts) {
				throw new SettingsError(
					'locked',
					`${path.basename(file)} is being written by another kamado`,
				);
			} else {
				await delay(pauseMs);
			}
		}
	}
	try {
		return await run();
	} finally {
		await handle.close();
		const holder = await readFile(lock, 'utf8').catch(() => null);
		if (holder === owner) {
			await rm(lock, { force: true });
		}
	}
}

/**
 * Writes the file by a rename of a finished one.
 * @param file - The settings file
 * @param settings - The content
 */
async function writeAtomic(file: string, settings: SettingsFile): Promise<void> {
	const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(settings, null, '\t')}\n`, {
			mode: 0o600,
		});
		await rename(temporary, file);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

/**
 * The time as `YYYYMMDDHHmmss` (UTC), for the name of the file put aside.
 * @param now - The time
 */
function stamp(now: Date): string {
	return now.toISOString().replaceAll(/[-:T]/g, '').replace(/\..*$/, '');
}

/**
 * A name for the file that is put aside, one that is not taken: a file put aside twice in a
 * second must not replace the first.
 * @param file - The settings file
 * @param now - The time
 */
async function backupName(file: string, now: Date): Promise<string> {
	const base = `${file}.${stamp(now)}`;
	for (let n = 0; ; n++) {
		const name = n === 0 ? `${base}.bak` : `${base}-${n}.bak`;
		if (
			await stat(name).then(
				() => false,
				() => true,
			)
		) {
			return name;
		}
	}
}

/** What an update did besides writing. */
export interface Updated {
	/** Set when the file was broken and put aside (its name, not its path). */
	readonly warning: string | null;
}

/**
 * Changes the file: reads it under the lock, applies `change`, and writes it. A file that is
 * not there is begun; one that is broken is put aside first (and `warning` says so); one that
 * is newer is not touched, and this throws.
 * @param file - The settings file
 * @param change - Makes the new content from the current one, or gives the current one back
 * when there is nothing to change (then nothing is written)
 * @throws {SettingsError} when the file is of a newer version or the lock is not got
 * @throws {Error} when it cannot be written
 */
async function update(
	file: string,
	change: (current: SettingsFile) => SettingsFile,
): Promise<Updated> {
	return withLock(file, async () => {
		const read = await readSettingsFile(file);
		let warning: string | null = null;
		let current: SettingsFile = {
			version: VERSION,
			global: DEFAULT_GLOBAL,
			projects: {},
		};
		if (read.state === 'newer') {
			throw new SettingsError(
				'newer',
				`${path.basename(file)} was written by a newer kamado (version ${read.version}): not changed`,
			);
		}
		if (read.state === 'ok') {
			current = read.settings;
		} else if (read.state === 'broken') {
			const backup = await backupName(file, new Date());
			await rename(file, backup);
			warning = `${path.basename(file)} could not be read (${read.reason}): it was moved to ${path.basename(backup)} and a new one begun`;
		}
		const next = change(current);
		// Written only when the change made something new: a save of nothing must not create the
		// file, make a file of a newer shape lose a field, or move the time of the file.
		if (next !== current) {
			await writeAtomic(file, next);
		}
		return { warning };
	});
}

/**
 * The settings of the screen of one project, and the way to change them.
 * @example
 * ```ts
 * const store = createSettingsStore(file, '/site/kamado.config.jsonc');
 * await store.open();
 * const view = await store.update({ global: { locale: 'ja' } });
 * ```
 */
export interface SettingsStore {
	/**
	 * Looks at the file when the screen starts: a broken one is put aside now (the screen starts
	 * with the defaults), a newer one is left. Nothing is written when the file is fine or not
	 * there.
	 */
	readonly open: () => Promise<Updated>;
	/** The settings as the screen is told them. */
	readonly view: () => Promise<SettingsView>;
	/**
	 * Saves a change and answers with the settings after it.
	 * @throws {Error} when the file is newer than this kamado, or cannot be written
	 */
	readonly update: (patch: SettingsPatch) => Promise<SettingsView>;
}

/**
 * Makes the store of one project.
 * @param file - The settings file
 * @param key - The project: the real path of its config file
 * @example
 * ```ts
 * const store = createSettingsStore('/home/u/.config/kamado/ui-settings.json', '/site/kamado.config.jsonc');
 * await store.update({ project: { pageSize: 100 } });
 * ```
 */
export function createSettingsStore(file: string, key: string): SettingsStore {
	let startWarning: string | null = null;
	const view = async (): Promise<SettingsView> => {
		let read: ReadResult;
		try {
			read = await readSettingsFile(file);
		} catch (error) {
			read = { state: 'broken', reason: reasonOf(error) };
		}
		if (read.state === 'ok') {
			return {
				global: read.settings.global,
				project: Object.hasOwn(read.settings.projects, key)
					? (read.settings.projects[key] ?? null)
					: null,
				warning: startWarning,
			};
		}
		let warning = startWarning;
		if (read.state === 'newer') {
			warning ??= `${path.basename(file)} was written by a newer kamado (version ${read.version}): it is not used and not changed`;
		} else if (read.state === 'broken') {
			warning ??= `${path.basename(file)} cannot be read (${read.reason}): the defaults are used`;
		}
		return { global: DEFAULT_GLOBAL, project: null, warning };
	};
	return {
		async open() {
			const read = await readSettingsFile(file).catch((error: unknown): ReadResult => ({
				state: 'broken',
				reason: reasonOf(error),
			}));
			if (read.state === 'broken') {
				// Put aside under the lock; a file that cannot be read at all (permissions) makes
				// the rename fail, and the screen starts with the defaults and says why.
				try {
					const updated = await update(file, (current) => current);
					startWarning = updated.warning;
				} catch (error) {
					startWarning = `${path.basename(file)} cannot be used: ${reasonOf(error)}`;
				}
			} else if (read.state === 'newer') {
				startWarning = `${path.basename(file)} was written by a newer kamado (version ${read.version}): it is not used and not changed`;
			}
			return { warning: startWarning };
		},
		view,
		async update(patch) {
			if (patch.global?.locale === undefined && patch.project === undefined) {
				// Nothing to keep: not even the lock is taken, or the directory made.
				return view();
			}
			const { warning } = await update(file, (current) => {
				// Own properties only: a key such as `__proto__` must not find the prototype.
				const entry = (Object.hasOwn(current.projects, key)
					? current.projects[key]
					: undefined) ?? {
					updatedAt: '',
					pageSize: DEFAULT_PAGE_SIZE,
				};
				const projects: Record<string, ProjectSettings> = { ...current.projects };
				if (patch.project !== undefined) {
					const sort =
						patch.project.sort === undefined
							? entry.sort
							: (patch.project.sort ?? undefined);
					const columns =
						patch.project.columns === undefined
							? entry.columns
							: (readColumns(patch.project.columns) ?? undefined);
					setOwn(projects, key, {
						updatedAt: new Date().toISOString(),
						pageSize: patch.project.pageSize ?? entry.pageSize,
						...(sort === undefined ? {} : { sort }),
						...(columns === undefined ? {} : { columns }),
					});
				}
				return {
					version: VERSION,
					global: { locale: patch.global?.locale ?? current.global.locale },
					projects,
				};
			});
			// What the start said was about a file that is now written whole; a file that went bad
			// since the start was put aside by this save, and that is said instead.
			startWarning = warning;
			return view();
		},
	};
}

/** The projects that have settings, for `kamado ui-settings list`. */
export type Listed =
	| { readonly state: 'missing' }
	| { readonly state: 'newer'; readonly version: number }
	| { readonly state: 'broken'; readonly reason: string }
	| {
			readonly state: 'ok';
			readonly global: GlobalSettings;
			readonly projects: readonly { readonly key: string; readonly updatedAt: string }[];
	  };

/**
 * Lists the projects that have settings. It only reads: a file that cannot be read is said,
 * not put aside.
 * @param file - The settings file
 * @example
 * ```ts
 * const listed = await listSettings(defaultSettingsFile());
 * ```
 */
export async function listSettings(file: string): Promise<Listed> {
	const read = await readSettingsFile(file);
	if (read.state !== 'ok') {
		return read;
	}
	return {
		state: 'ok',
		global: read.settings.global,
		projects: Object.entries(read.settings.projects).map(([key, entry]) => ({
			key,
			updatedAt: entry.updatedAt,
		})),
	};
}

/**
 * Removes the settings of one project (the project then has the defaults). The file is not
 * made when there is none.
 * @param file - The settings file
 * @param key - The project: the real path of its config file
 * @returns Whether the project had settings, and the warning of the update
 * @throws {Error} when the file is newer than this kamado
 * @example
 * ```ts
 * await removeProjectSettings(file, '/site/kamado.config.jsonc'); // { removed: true, warning: null }
 * ```
 */
export async function removeProjectSettings(
	file: string,
	key: string,
): Promise<{ removed: boolean; warning: string | null }> {
	const before = await readSettingsFile(file);
	if (
		before.state === 'missing' ||
		(before.state === 'ok' && !Object.hasOwn(before.settings.projects, key))
	) {
		// Nothing to take out of a file that is whole: no lock, and no write.
		return { removed: false, warning: null };
	}
	let removed = false;
	const { warning } = await update(file, (current) => {
		removed = Object.hasOwn(current.projects, key);
		if (!removed) {
			// Nothing to take out: the file is not written again (it would lose the fields of
			// another project that this version does not know).
			return current;
		}
		const projects: Record<string, ProjectSettings> = { ...current.projects };
		delete projects[key];
		return { ...current, projects };
	});
	return { removed, warning };
}

/**
 * Removes the file: the settings of every project and the global ones. It is what a person
 * asks for with `--all`, so a file of a newer version or a broken one goes too.
 * @param file - The settings file
 * @returns Whether there was a file
 * @example
 * ```ts
 * await removeAllSettings(defaultSettingsFile());
 * ```
 */
export async function removeAllSettings(file: string): Promise<boolean> {
	// A file that cannot be read is still removed: this is what `--all` is for.
	const before = await readSettingsFile(file).catch(() => ({ state: 'unreadable' }));
	if (before.state === 'missing') {
		return false;
	}
	await withLock(file, async () => {
		await rm(file, { force: true });
	});
	return true;
}
