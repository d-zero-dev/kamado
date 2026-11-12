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
 * export default async (pages: readonly PageMapEntry[], ctx: SyncContext) => {
 * 	ctx.log('info', `${pages.length} pages under ${ctx.inputDir}`);
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
 * One page of what a script returns: the page as it should be. A {@link PageMapEntry} is one,
 * returned as it is; only these four fields are read, and the rest is ignored.
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
	 * The metadata the page should have, all of it: a key that is not here is removed from the
	 * page. Left out, the metadata of the page is not touched. Values are JSON.
	 */
	readonly meta?: Readonly<Record<string, unknown>>;
}

/**
 * What a script returns: nothing (or `null`) to change nothing, or every page the site should
 * have. A page that exists and is not in the list is removed.
 * @example
 * ```ts
 * const nothing: SyncResult = null;
 * const pages: SyncResult = [{ url: '/', virtual: false }];
 * ```
 */
export type SyncResult = void | null | readonly SyncPage[];

/**
 * A script of `ui.syncFunctions`: the default export of its module.
 * @example
 * ```ts
 * import type { SyncScript } from 'kamado';
 *
 * const script: SyncScript = async (pages) => {
 * 	return pages.map((page) => ({ url: page.url, meta: { ...page.meta, checked: true } }));
 * };
 * export default script;
 * ```
 */
export type SyncScript = (
	pages: readonly PageMapEntry[],
	ctx: SyncContext,
) => SyncResult | Promise<SyncResult>;

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
 * 	console.log(outcome.summary.counts);
 * }
 * ```
 */
export interface SyncOutcome {
	/** `false` when the script returned nothing, or what it returned is what the site is. */
	readonly applied: boolean;
	readonly summary: SyncSummary;
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
	 * (`kamado sync` asks on the terminal; the function does not).
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
