/**
 * The types of a sync script (RFC §14.2, "同期"): what a script of `ui.syncFunctions` is
 * given and what it returns. They are exported from `kamado`, so that a script can say what it
 * is without a dependency on anything but this package.
 */
import type { PageMapEntry } from '../pages.js';

/**
 * A text as the screen shows it: one text, or a text per language of the screen (`en`, `ja`).
 * @example
 * ```ts
 * const same: Label = 'Import';
 * const translated: Label = { en: 'Import from the sheet', ja: 'シートから取り込む' };
 * ```
 */
export type Label = string | Readonly<Record<string, string>>;

/**
 * What a script is given besides the pages.
 * @example
 * ```ts
 * export default {
 * 	read: async (pages: readonly PageMapEntry[], ctx: SyncContext) => {
 * 		ctx.log('info', `${pages.length} pages under ${ctx.inputDir}`);
 * 		return [{ url: '/', inputPath: 'index.html', meta: { title: 'Home' } }];
 * 	},
 * };
 * ```
 */
export interface SyncContext {
	/**
	 * Writes a line of the log: to the dialog of the screen while the script runs, and to the
	 * standard error of `kamado sync`. A line that is too long is cut, and the oldest lines of a
	 * long log are dropped (the log says so). What is written is shown as text, with its control
	 * characters spelled out.
	 * @param type - `info`, `warn` or `error`
	 * @param message - The line
	 */
	log(type: 'info' | 'warn' | 'error', message: string): void;
	/**
	 * The absolute path of `dir.input`, the directory `inputPath` is relative to when a script
	 * gives one back. Use it to write the path of a page file relative to it, so that a sheet
	 * does not carry the path of a machine.
	 */
	readonly inputDir: string;
}

/**
 * One page of what `select` or `read` returns. A {@link PageMapEntry} is one, returned as it
 * is; only these four fields are read, and the rest is ignored.
 * @example
 * ```ts
 * const page: SyncPage = {
 * 	url: '/about/history/',
 * 	inputPath: 'about/history/index.html',
 * 	virtual: false,
 * 	meta: { title: 'History' },
 * };
 * ```
 */
export interface SyncPage {
	/** The URL the page has: `/`, then the path (`/about/`, `/a.html`). */
	readonly url: string;
	/**
	 * Where the page file is, relative to `dir.input` with `/` (an absolute path inside
	 * `dir.input` is taken as the relative one). It is how a page that is given again is
	 * recognised, whatever its URL became: the same `inputPath` is the same page, and a page whose
	 * `url` changed is moved, not made again. Leave it out for a page that has no file (a virtual
	 * page, or one whose place is its URL's).
	 */
	readonly inputPath?: string | null;
	/**
	 * Whether the page has no file and exists as an entry of `pages.overrides`. Left out, a page
	 * that exists stays as it is; for a page that does not exist yet, it must be given.
	 */
	readonly virtual?: boolean;
	/**
	 * The metadata of the page, for the keys of the range `select` gave. In an import, a key of the
	 * range that is not here is removed from the page, and a key outside the range stays as it is.
	 * Left out, the metadata of the page is not touched. Values are JSON.
	 */
	readonly meta?: Readonly<Record<string, unknown>>;
}

/**
 * What a script of an import gives (RFC §14.2, "同期"): the pages of the site that the outside
 * data corresponds to (`select`), and the pages the outside data has (`read`). A sync finds the
 * difference between the two and changes the site to what `read` returned, in the range `select`
 * gave: a page or a key that `select` leaves out is not touched.
 * @example
 * ```ts
 * import type { SyncImport } from 'kamado';
 *
 * const script: SyncImport = {
 * 	select: (pages) => pages.map((page) => ({ url: page.url, inputPath: page.inputPath, meta: { title: page.meta.title } })),
 * 	read: async () => [{ url: '/', inputPath: 'index.html', meta: { title: 'Home' } }],
 * };
 * export default script;
 * ```
 */
export interface SyncImport {
	/**
	 * The range of the site the data corresponds to: the pages, and the keys of `meta` of each.
	 * Left out, it is every page with every field (`virtual`, and all of `meta`).
	 */
	readonly select?: (
		pages: readonly PageMapEntry[],
		ctx: SyncContext,
	) => readonly SyncPage[] | Promise<readonly SyncPage[]>;
	/** The pages the outside data has, in the range `select` gave. */
	readonly read: (
		pages: readonly PageMapEntry[],
		ctx: SyncContext,
	) => readonly SyncPage[] | Promise<readonly SyncPage[]>;
}

/**
 * What a write is given (see {@link SyncExport}).
 * @example
 * ```ts
 * const write = async ({ rows, changes }: SyncWriteInput) => {
 * 	console.log(rows.length, changes?.length);
 * };
 * ```
 */
export interface SyncWriteInput {
	/** What `select` returned (every page when it was left out), as JSON: what the outside data should be. */
	readonly rows: readonly SyncPage[];
	/**
	 * What differs between what `read` returned and `rows`, as the confirmation showed it. Not
	 * given when the script has no `read`: then nothing was compared.
	 */
	readonly changes?: readonly SyncChange[];
	/** Every page of the site (`kamado pages`), as the script was given them. */
	readonly pages: readonly PageMapEntry[];
}

/**
 * What a script of an export gives (RFC §14.2, "同期"): the range of the site to write out
 * (`select`), the data as it is outside (`read`), and the means to write (`write`). `write` runs
 * only after the difference is shown and confirmed; nothing is written before. Without `read`,
 * nothing can be compared, so the confirmation asks only whether to write.
 * @example
 * ```ts
 * import type { SyncExport } from 'kamado';
 *
 * const script: SyncExport = {
 * 	select: (pages) => pages.map((page) => ({ url: page.url, meta: { title: page.meta.title } })),
 * 	read: async () => await readSheet(),
 * 	write: async ({ rows }) => {
 * 		await writeSheet(rows);
 * 	},
 * };
 * export default script;
 * ```
 */
export interface SyncExport {
	/** The range of the site to write out. Left out, it is every page with every field. */
	readonly select?: SyncImport['select'];
	/** The pages the outside data has now. Left out, no difference is shown. */
	readonly read?: SyncImport['read'];
	/** Writes `rows` outside. Called once, after the confirmation. */
	readonly write: (input: SyncWriteInput, ctx: SyncContext) => void | Promise<void>;
}

/**
 * A script of `ui.syncFunctions`: the default export of its module. With `write` it writes out
 * (the site to the outside data); without it, it imports (the outside data to the site).
 * @example
 * ```ts
 * import type { SyncScript } from 'kamado';
 *
 * const script: SyncScript = {
 * 	read: async () => [{ url: '/', virtual: false, meta: { checked: true } }],
 * };
 * export default script;
 * ```
 */
export type SyncScript = SyncImport | SyncExport;

/**
 * Which way a sync goes: the outside data into the site, or the site out. A script that has
 * `write` goes out; one that has none comes in.
 * @example
 * ```ts
 * const direction: SyncDirection = 'import';
 * ```
 */
export type SyncDirection = 'import' | 'export';

/**
 * The kinds of change a sync finds, as the summary counts them.
 * @example
 * ```ts
 * const kinds: SyncChangeKind[] = ['added', 'deleted', 'movedUrl'];
 * ```
 */
export type SyncChangeKind =
	| 'added'
	| 'deleted'
	| 'movedUrl'
	| 'movedFile'
	| 'virtualized'
	| 'materialized'
	| 'meta';

/**
 * One change a sync would make. Paths are relative to `dir.input`. Text that came from the script
 * or from the files has its control characters spelled out before it is shown.
 * @example
 * ```ts
 * const change: SyncChange = { kind: 'movedUrl', from: '/about/', to: '/company/' };
 * ```
 */
export type SyncChange =
	| {
			readonly kind: 'added';
			readonly url: string;
			readonly virtual: boolean;
			readonly inputPath: string | null;
			/** How many keys of metadata the page is given. */
			readonly keys: number;
	  }
	| { readonly kind: 'deleted'; readonly url: string; readonly inputPath: string | null }
	| { readonly kind: 'movedUrl'; readonly from: string; readonly to: string }
	| {
			readonly kind: 'movedFile';
			readonly url: string;
			readonly from: string | null;
			readonly to: string;
	  }
	| { readonly kind: 'virtualized'; readonly url: string; readonly inputPath: string }
	| {
			readonly kind: 'materialized';
			readonly url: string;
			readonly inputPath: string | null;
	  }
	| {
			readonly kind: 'meta';
			readonly url: string;
			readonly key: string;
			/** The value the page has; absent when the key is new. */
			readonly before?: unknown;
			/** The value after; absent when the key is removed. */
			readonly after?: unknown;
	  };

/**
 * What a sync would change, counted and listed.
 * @example
 * ```ts
 * const summary: SyncSummary = {
 * 	counts: { added: 1, deleted: 0, movedUrl: 0, movedFile: 0, virtualized: 0, materialized: 0, meta: 2 },
 * 	changes: [],
 * 	unsaved: [],
 * };
 * ```
 */
export interface SyncSummary {
	readonly counts: Readonly<Record<SyncChangeKind, number>>;
	/** Every change, in a stable order (removed, moved, added, then metadata). */
	readonly changes: readonly SyncChange[];
	/**
	 * The files a removal, a virtualization or a move touches, and `pages.overrides` when the sync
	 * writes it, that git cannot bring back: files with changes that are not committed (new files
	 * and files git ignores too), relative to `dir.input` (so `../pages.overrides.json` when that
	 * file is beside the config). Empty when there are none.
	 */
	readonly unsaved: readonly string[];
	/**
	 * Set when git cannot tell (it is not there, the directory is not a repository, or nothing is
	 * committed yet): then no file of the sync can be brought back by git.
	 */
	readonly gitUnavailable?: boolean;
}

/**
 * What `sync()` did.
 * @example
 * ```ts
 * const outcome: SyncOutcome = await sync('/site/kamado.config.jsonc', 'import', { yes: true });
 * if (outcome.applied) {
 * 	console.log(outcome.direction, outcome.summary.counts);
 * }
 * ```
 */
export interface SyncOutcome {
	/** `false` when there was no difference, or the changes were declined. */
	readonly applied: boolean;
	readonly summary: SyncSummary;
	/** Which way the sync went (the shape of the script decides it). */
	readonly direction: SyncDirection;
}

/**
 * Options of `sync()`.
 * @example
 * ```ts
 * const options: SyncOptions = { yes: true, write: (text) => process.stderr.write(text) };
 * ```
 */
export interface SyncOptions {
	/**
	 * Apply without asking. Without it, a sync that has changes to make writes nothing and throws
	 * (`kamado sync` asks on the terminal; the function does not). An export whose script has no
	 * `read` has no difference to look at, so without `yes` it always throws.
	 */
	readonly yes?: boolean;
	/**
	 * The cache directory (the same as `build`'s `cacheDir`): a relative path is relative to the
	 * directory of the config file.
	 */
	readonly cacheDir?: string;
	/**
	 * Where the lines of `ctx.log` go (default: the standard error). Each call has one line, as
	 * `[info] message` (the type in brackets), with its newline.
	 */
	readonly write?: (text: string) => void;
}
