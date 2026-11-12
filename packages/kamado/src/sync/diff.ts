/**
 * The difference between the pages the site has and the pages a sync script returned (RFC
 * §14.2, "同期"): a pure function from the list the core gave and the rows the script returned
 * to the edits of one batch and the summary the person confirms.
 *
 * What it decides, and nothing else:
 * - which page a row is (the same `inputPath`, else the same `url`: never a guess from the
 *   likeness of two pages), and so whether a page is moved, made, or removed;
 * - what differs inside a page that is the same (`virtual`, the keys of `meta`);
 * - what cannot be taken, told all at once.
 *
 * Why it never writes and never asks the core: the difference has to be shown before anything is
 * written, and the same function has to give the same edits to the screen, to `kamado sync` and
 * to the tests that check its laws (what is returned unchanged changes nothing; what was applied
 * and is returned again changes nothing).
 *
 * Why a different `inputPath` moves a file only for a page whose URL a key decides: the URL of any
 * other page is where its file is, so a file cannot be moved without the URL changing, and a row
 * that keeps its `url` and names another place would put the page at another URL. The row of a page
 * whose URL was changed (matched by its old `inputPath`) is given again with that old `inputPath`
 * by a script that returns what it was given, and that must be no change the second time: so for
 * those pages the `inputPath` only recognises the page.
 *
 * Why the key that decides the URL is left out of the comparison on both sides: the URL is told
 * by `url`, and the core refuses a key that would move the page by a way that skips the checks of
 * a URL (RFC §14.2).
 */

import type { PageMapEntry } from '../pages.js';
import type { SyncChange, SyncChangeKind, SyncSummary } from './types.js';

import path from 'node:path';

/** What the editor of the core can do to a page (`change.op` of an edit, RFC §14.2). */
export type EditOp =
	| 'set'
	| 'delete'
	| 'moveUrl'
	| 'movePath'
	| 'revert'
	| 'create'
	| 'virtualize'
	| 'materialize'
	| 'deletePage';

/**
 * Which edits a sync makes, and why it does not make the others. A sync that cannot make an
 * edit that the editor can make is a sync that silently misses what it was changed to do, so
 * this table is the place that says it on purpose: a new edit is a compile error here until it is
 * said, and `coverage.spec.ts` checks the table against the edits the core accepts (so an edit added
 * to the core only is found too). When an edit is added, the difference (`diff`) and the batch it
 * is applied in must be looked at in the same change (RFC §14.2, "同期とページの編集の連動").
 */
export const EDIT_OPS = {
	set: 'used',
	delete: 'used',
	moveUrl: 'used',
	movePath: 'used',
	create: 'used',
	virtualize: 'used',
	materialize: 'used',
	deletePage: 'used',
	revert:
		'unused: it puts a value back as a commit had it, and what a commit holds is not something a script returns',
} as const satisfies Record<EditOp, string>;

/**
 * Which fields of a page of the list (`PageMapEntry`) a sync reads of what a script returns, and
 * why it ignores the others. The script is given every field; it is returned what it wants of them.
 * A field added to the list is a compile error here until it is said, and `coverage.spec.ts` checks
 * the table against the fields the core writes.
 */
export const ENTRY_FIELDS = {
	url: 'read',
	inputPath: 'read',
	virtual: 'read',
	meta: 'read',
	outputPath:
		'ignored: it follows from the url and the settings, and is where a page is written',
	fileSlug: 'ignored: it follows from the url',
	filePathStem: 'ignored: it follows from the place of the file',
	extension: 'ignored: the extension of a file is its own, and is not changed by a sync',
	depth: 'ignored: it follows from the url',
	parent: 'ignored: it follows from the url',
} as const satisfies Record<keyof PageMapEntry, string>;

/** A page of the list the core gives for a sync (`uiSyncPages`). */
export interface SnapshotPage extends PageMapEntry {
	/** The hashes of the files the page was read from; `null` for a file that is not there. */
	readonly hashes: { readonly input: string | null; readonly sidecar: string | null };
	/**
	 * The keys that cannot be edited, from key to why. Left out when it is not known: telling it
	 * reads and parses the page file, so the list does not carry it for every page. A difference
	 * that needs it says which pages (`needsLocked` of the result), and is made again with it.
	 */
	readonly locked?: Readonly<Record<string, string>>;
}

/** What the core gives for a sync (`uiSyncPages`). */
export interface Snapshot {
	/** The version of the editor the list was made at. */
	readonly version: number;
	/** The hash of `pages.overrides`, or `null` when the site has none. */
	readonly overridesHash: string | null;
	/** The absolute `dir.input`. */
	readonly inputDir: string;
	/** The absolute path of `pages.overrides`, or `null` when the site has none. */
	readonly overridesFile?: string | null;
	/** The key that decides the URL (`pages.outputPathField`), or `null`. */
	readonly outputPathField: string | null;
	readonly pages: readonly SnapshotPage[];
	readonly warnings: readonly string[];
}

/** One edit of the batch (`uiEditBatch`): the page as it is before the batch, what to expect, what to do. */
export interface BatchEdit {
	readonly url: string;
	readonly expect: Readonly<Record<string, string | null>>;
	readonly change: Readonly<Record<string, unknown>>;
}

/** A row of the result that cannot be taken. */
export interface Problem {
	/** The place of the row in the result, from 1; `null` when the result as a whole is the problem. */
	readonly row: number | null;
	/** The `url` of the row when it has one. */
	readonly url: string | null;
	/** What is wrong, in a line that names the row. */
	readonly message: string;
}

/** What {@link diff} gives. */
export type DiffResult =
	| {
			readonly ok: true;
			readonly edits: readonly BatchEdit[];
			readonly summary: Pick<SyncSummary, 'counts' | 'changes'>;
			/**
			 * The files (absolute) that a removal, a virtualization or a move takes from the place
			 * they are in: the page file, and its sidecar when there is one.
			 */
			readonly filesAtRisk: readonly string[];
			readonly needsLocked: readonly string[];
	  }
	| {
			readonly ok: false;
			readonly problems: readonly Problem[];
			readonly needsLocked: readonly string[];
	  };

/** What a page has locked when it is not told. */
const NO_LOCKS: Readonly<Record<string, string>> = {};

/** A row of the result that was read and found well formed. */
interface Row {
	readonly index: number;
	readonly url: string;
	/** Relative to `dir.input`; `undefined` when the row does not say, `null` when it says there is none. */
	readonly inputPath: string | null | undefined;
	readonly virtual: boolean | undefined;
	/** The keys the page should have; `undefined` when the row leaves the metadata alone. */
	readonly meta: ReadonlyMap<string, unknown> | undefined;
}

/**
 * Whether two JSON values are the same: objects by their keys and values (the order of keys
 * does not matter), arrays by their items in order, the rest by `Object.is`'s idea of equal
 * except that `0` and `-0` are one value (they are one JSON number).
 * @param a - A value
 * @param b - Another
 * @example
 * ```ts
 * sameJson({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }); // true
 * sameJson('1', 1); // false
 * ```
 */
export function sameJson(a: unknown, b: unknown): boolean {
	if (a === b) {
		return true;
	}
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
		return false;
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		return (
			Array.isArray(a) &&
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((item, i) => sameJson(item, b[i]))
		);
	}
	const left = Object.entries(a);
	const right = new Map(Object.entries(b));
	return (
		left.length === right.size &&
		left.every(([key, value]) => right.has(key) && sameJson(value, right.get(key)))
	);
}

/**
 * Whether a value is an object that is not an array.
 * @param value - Any value
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The path of a file relative to `dir.input`, with `/`.
 * @param inputDir - The absolute `dir.input`
 * @param absolute - The absolute path of a file in it
 */
function relativeTo(inputDir: string, absolute: string): string {
	return path.relative(inputDir, absolute).split(path.sep).join('/');
}

/**
 * Reads the `inputPath` of a row as a path relative to `dir.input`.
 * @param value - What the row has
 * @param inputDir - The absolute `dir.input`
 * @returns The path, or the reason it is not one
 */
function readInputPath(
	value: string,
	inputDir: string,
): { path: string } | { reason: string } {
	if (value === '') {
		return { reason: 'inputPath must not be empty' };
	}
	if (path.isAbsolute(value)) {
		const relative = relativeTo(inputDir, value);
		return relative === '' ||
			relative === '..' ||
			relative.startsWith('../') ||
			path.isAbsolute(relative)
			? { reason: 'inputPath is outside dir.input' }
			: { path: relative };
	}
	const normal = path.posix.normalize(value);
	return normal === '.' || normal === '..' || normal.startsWith('../')
		? { reason: 'inputPath is outside dir.input' }
		: { path: normal };
}

/**
 * Where the sidecar of a page file is: the same place with `.json` for its extension.
 * @param input - The absolute path of the page file
 */
function sidecarOf(input: string): string {
	const extension = path.extname(input);
	return `${input.slice(0, input.length - extension.length)}.json`;
}

/**
 * Finds what the result changes in the site.
 * @param snapshot - The pages the site has (`uiSyncPages`), as of the moment the script was given them
 * @param rows - What the script returned: an array of pages (`SyncResult`)
 * @returns The edits of one batch and the summary, or every problem of the result (and no edits)
 * @example
 * ```ts
 * const result = diff(snapshot, [{ url: '/about/', inputPath: 'about/index.html' }]);
 * if (result.ok) {
 * 	console.log(result.edits.length, result.summary.counts);
 * }
 * ```
 */
export function diff(snapshot: Snapshot, rows: readonly unknown[]): DiffResult {
	const problems: Problem[] = [];
	const { inputDir, outputPathField } = snapshot;
	// The pages whose locked keys the difference needed and was not told: asked for, and the
	// difference made again (see `needsLocked`). Until it is told, nothing is locked.
	const needsLocked = new Set<string>();
	const lockedOf = (page: SnapshotPage): Readonly<Record<string, string>> => {
		if (page.locked === undefined) {
			needsLocked.add(page.url);
			return NO_LOCKS;
		}
		return page.locked;
	};
	const problem = (row: Row | number, url: string | null, message: string) => {
		const index = typeof row === 'number' ? row : row.index;
		problems.push({
			row: index,
			url,
			message: `row ${index}${url === null ? '' : ` (${url})`}: ${message}`,
		});
	};

	// 1. What each row says, if it is well formed. A row with a problem is told and left out of
	// the rest, so that one mistake does not hide the others and does not make more.
	const read: Row[] = [];
	const urls = new Map<string, number>();
	const inputPaths = new Map<string, number>();
	for (const [i, raw] of rows.entries()) {
		const index = i + 1;
		if (!isPlainObject(raw)) {
			problem(index, null, 'must be an object');
			continue;
		}
		const { url } = raw;
		if (typeof url !== 'string' || !url.startsWith('/')) {
			problem(
				index,
				typeof url === 'string' ? url : null,
				'url must be a string that starts with /',
			);
			continue;
		}
		let ok = true;
		const firstUrl = urls.get(url);
		if (firstUrl === undefined) {
			urls.set(url, index);
		} else {
			problem(index, url, `the url is already the url of row ${firstUrl}`);
			ok = false;
		}

		let inputPath: string | null | undefined;
		if (raw.inputPath === undefined || raw.inputPath === null) {
			inputPath = raw.inputPath;
		} else if (typeof raw.inputPath === 'string') {
			const given = readInputPath(raw.inputPath, inputDir);
			if ('reason' in given) {
				problem(index, url, given.reason);
				ok = false;
			} else {
				inputPath = given.path;
				const first = inputPaths.get(given.path);
				if (first === undefined) {
					inputPaths.set(given.path, index);
				} else {
					problem(index, url, `inputPath is already the inputPath of row ${first}`);
					ok = false;
				}
			}
		} else {
			problem(index, url, 'inputPath must be a string or null');
			ok = false;
		}

		let virtual: boolean | undefined;
		if (raw.virtual === undefined || typeof raw.virtual === 'boolean') {
			virtual = raw.virtual;
		} else {
			problem(index, url, 'virtual must be true or false');
			ok = false;
		}
		if (virtual === true && typeof inputPath === 'string') {
			problem(index, url, 'a virtual page has no inputPath: give inputPath null');
			ok = false;
		}

		let meta: Map<string, unknown> | undefined;
		if (raw.meta !== undefined) {
			if (isPlainObject(raw.meta)) {
				meta = new Map(Object.entries(raw.meta));
			} else {
				problem(index, url, 'meta must be an object');
				ok = false;
			}
		}
		if (ok) {
			read.push({ index, url, inputPath, virtual, meta });
		}
	}

	// 2. Which page each row is.
	const byInput = new Map<string, SnapshotPage>();
	const byUrl = new Map<string, SnapshotPage>();
	for (const page of snapshot.pages) {
		byUrl.set(page.url, page);
		if (!page.virtual && page.inputPath !== null) {
			byInput.set(relativeTo(inputDir, page.inputPath), page);
		}
	}
	const taken = new Set<SnapshotPage>();
	const matched = new Map<Row, SnapshotPage>();
	for (const row of read) {
		if (typeof row.inputPath === 'string') {
			const page = byInput.get(row.inputPath);
			if (page !== undefined) {
				taken.add(page);
				matched.set(row, page);
			}
		}
	}
	for (const row of read) {
		if (matched.has(row)) {
			continue;
		}
		const page = byUrl.get(row.url);
		if (page !== undefined && !taken.has(page)) {
			taken.add(page);
			matched.set(row, page);
		}
	}

	// 3. What each row asks for.
	const edits: BatchEdit[] = [];
	const found: Record<SyncChangeKind, SyncChange[]> = {
		added: [],
		deleted: [],
		movedUrl: [],
		movedFile: [],
		virtualized: [],
		materialized: [],
		meta: [],
	};
	const filesAtRisk = new Set<string>();
	// `pages.overrides` is written by what makes, removes, gives a file to or makes virtual a page
	// with no file, and by a key of such a page: an entry that is lost with it is in no commit when
	// the file has changes that are not committed (or is not tracked).
	const writesOverrides = (): void => {
		if (snapshot.overridesFile !== null && snapshot.overridesFile !== undefined) {
			filesAtRisk.add(snapshot.overridesFile);
		}
	};
	const riskOf = (page: SnapshotPage) => {
		if (page.inputPath === null) {
			return;
		}
		filesAtRisk.add(page.inputPath);
		if (page.hashes.sidecar !== null) {
			filesAtRisk.add(sidecarOf(page.inputPath));
		}
	};
	const expectOf = (page: SnapshotPage) => ({
		input: page.hashes.input,
		sidecar: page.hashes.sidecar,
		overrides: snapshot.overridesHash,
	});
	const NEW = { input: null, sidecar: null, overrides: snapshot.overridesHash };

	// The urls pages are made at: an edit that names one of them names the page that is made.
	const madeUrls = new Set(read.filter((row) => !matched.has(row)).map((row) => row.url));
	for (const row of read) {
		const page = matched.get(row);
		if (page === undefined) {
			addPage(row);
			continue;
		}
		const first = edits.length;
		const expect = expectOf(page);
		const currentPath =
			page.inputPath === null ? null : relativeTo(inputDir, page.inputPath);

		if (page.virtual && row.virtual === undefined && typeof row.inputPath === 'string') {
			problem(
				row,
				row.url,
				'the page is virtual, so give virtual: false to give it a file',
			);
			continue;
		}
		if (row.url !== page.url) {
			edits.push({
				url: page.url,
				expect,
				change: { op: 'moveUrl', url: row.url },
			});
			found.movedUrl.push({ kind: 'movedUrl', from: page.url, to: row.url });
			riskOf(page);
		}
		if (page.virtual) {
			if (row.virtual === false) {
				const to = typeof row.inputPath === 'string' ? row.inputPath : null;
				edits.push({
					url: page.url,
					expect,
					change: { op: 'materialize', path: to },
				});
				found.materialized.push({ kind: 'materialized', url: page.url, inputPath: to });
				writesOverrides();
			}
		} else if (row.virtual === true) {
			edits.push({ url: page.url, expect, change: { op: 'virtualize' } });
			found.virtualized.push({
				kind: 'virtualized',
				url: page.url,
				inputPath: currentPath ?? '',
			});
			riskOf(page);
			writesOverrides();
		} else if (
			typeof row.inputPath === 'string' &&
			row.inputPath !== currentPath &&
			outputPathField !== null &&
			lockedOf(page)[outputPathField] !== undefined
		) {
			edits.push({
				url: page.url,
				expect,
				change: { op: 'movePath', path: row.inputPath },
			});
			found.movedFile.push({
				kind: 'movedFile',
				url: page.url,
				from: currentPath,
				to: row.inputPath,
			});
			riskOf(page);
		}

		if (row.meta !== undefined) {
			keysOf(row, page, expect);
		}
		if (
			row.url !== page.url &&
			madeUrls.has(page.url) &&
			edits
				.slice(first)
				.some(
					(e) =>
						e.change.op === 'set' ||
						e.change.op === 'delete' ||
						e.change.op === 'materialize',
				)
		) {
			// An edit names a page by the url it has before the batch, and one that names a url a page
			// is made at names the page that is made: the page that moves off it cannot be named.
			problem(
				row,
				row.url,
				`the page moves away from ${page.url} and another page is made there, so a key or the file of the moved page cannot be told apart from those of the new one (the same url names both): do it in a sync of its own after the move`,
			);
		}
	}

	/**
	 * A page that no page of the site is: made as the row says, and given its keys.
	 * @param row - The row
	 */
	function addPage(row: Row): void {
		if (row.virtual === undefined) {
			problem(
				row,
				row.url,
				'the page does not exist yet, so virtual must be true or false',
			);
			return;
		}
		const to = typeof row.inputPath === 'string' ? row.inputPath : null;
		if (row.virtual || to === null) {
			// made as an entry of pages.overrides (and, with no place given, given its file after)
			writesOverrides();
		}
		edits.push({
			url: row.url,
			expect: NEW,
			change: { op: 'create', path: row.virtual ? null : to },
		});
		if (!row.virtual && to === null) {
			edits.push({
				url: row.url,
				expect: NEW,
				change: { op: 'materialize', path: null },
			});
		}
		let keys = 0;
		for (const [key, value] of row.meta ?? []) {
			if (key === outputPathField) {
				continue;
			}
			keys += 1;
			edits.push({
				url: row.url,
				expect: NEW,
				change: { op: 'set', key, value },
			});
		}
		found.added.push({
			kind: 'added',
			url: row.url,
			virtual: row.virtual,
			inputPath: row.virtual ? null : to,
			keys,
		});
	}

	/**
	 * The keys of a page that is the same: those that differ are set, those the row leaves out
	 * are removed.
	 * @param row - The row, which has `meta`
	 * @param page - The page it is
	 * @param expect - What the edits expect of the page
	 */
	function keysOf(
		row: Row,
		page: SnapshotPage,
		expect: Readonly<Record<string, string | null>>,
	): void {
		const now = new Map(Object.entries(page.meta));
		let locked: Map<string, string> | undefined;
		const whyLocked = (key: string): string | undefined => {
			locked ??= new Map(Object.entries(lockedOf(page)));
			return locked.get(key);
		};
		for (const [key, value] of row.meta ?? []) {
			if (key === outputPathField) {
				continue;
			}
			const had = now.has(key);
			if (had && sameJson(now.get(key), value)) {
				continue;
			}
			const why = whyLocked(key);
			if (why !== undefined) {
				problem(row, row.url, `the key ${key} cannot be changed: ${why}`);
				continue;
			}
			if (page.virtual) {
				writesOverrides();
			}
			edits.push({
				url: page.url,
				expect,
				change: { op: 'set', key, value },
			});
			found.meta.push({
				kind: 'meta',
				url: page.url,
				key,
				...(had ? { before: now.get(key) } : {}),
				after: value,
			});
		}
		for (const [key, before] of now) {
			if (key === outputPathField || row.meta?.has(key) === true) {
				continue;
			}
			const why = whyLocked(key);
			if (why !== undefined) {
				problem(row, row.url, `the key ${key} cannot be removed: ${why}`);
				continue;
			}
			if (page.virtual) {
				writesOverrides();
			}
			edits.push({ url: page.url, expect, change: { op: 'delete', key } });
			found.meta.push({ kind: 'meta', url: page.url, key, before });
		}
	}

	// 4. A page no row is goes.
	for (const page of snapshot.pages) {
		if (taken.has(page)) {
			continue;
		}
		if (page.virtual) {
			writesOverrides();
		}
		edits.push({ url: page.url, expect: expectOf(page), change: { op: 'deletePage' } });
		found.deleted.push({
			kind: 'deleted',
			url: page.url,
			inputPath: page.inputPath === null ? null : relativeTo(inputDir, page.inputPath),
		});
		riskOf(page);
	}

	if (problems.length > 0) {
		// The problems of the rows (what is wrong with a row) come before those found when the
		// rows are matched (the pages that do not exist yet), in the order of the rows within each.
		return { ok: false, problems, needsLocked: [...needsLocked] };
	}

	const order: readonly SyncChangeKind[] = [
		'deleted',
		'movedUrl',
		'movedFile',
		'virtualized',
		'materialized',
		'added',
		'meta',
	];
	return {
		ok: true,
		edits,
		summary: {
			counts: {
				added: found.added.length,
				deleted: found.deleted.length,
				movedUrl: found.movedUrl.length,
				movedFile: found.movedFile.length,
				virtualized: found.virtualized.length,
				materialized: found.materialized.length,
				meta: found.meta.length,
			},
			changes: order.flatMap((kind) => found[kind]),
		},
		filesAtRisk: [...filesAtRisk],
		needsLocked: [...needsLocked],
	};
}
