import { assertKnownOptions } from './known-options.js';
import { native } from './native.js';

/**
 * What `pages()` takes; every field is optional and defaults to the config.
 * @example
 * ```ts
 * const options: PagesOptions = { incremental: true, cacheDir: '/tmp/kamado-cache' };
 * ```
 */
export interface PagesOptions {
	/**
	 * Read the plan cache and update it, as `build`'s `incremental` does: a file whose size and
	 * modification time are what the cache recorded is not read again.
	 */
	readonly incremental?: boolean;
	/**
	 * Where the plan cache is kept (the same as `build`'s `cacheDir`): a relative path is relative
	 * to the directory of the config file.
	 */
	readonly cacheDir?: string;
}

/**
 * Keys {@link pages} / {@link pagesJson} read. Kept next to {@link PagesOptions} so a new
 * field is either allowed here or refused as `unknown option`.
 */
export const PAGES_OPTION_KEYS = [
	'incremental',
	'cacheDir',
] as const satisfies readonly (keyof PagesOptions)[];

/**
 * One page of the map.
 * @example
 * ```ts
 * // /about/history.html
 * const entry: PageMapEntry = {
 * 	url: '/about/history.html',
 * 	inputPath: '/site/src/about/history.html',
 * 	outputPath: '/site/htdocs/about/history.html',
 * 	fileSlug: 'history',
 * 	filePathStem: '/about/history',
 * 	extension: '.html',
 * 	depth: 2,
 * 	parent: '/about/',
 * 	virtual: false,
 * 	meta: { title: 'History' },
 * };
 * ```
 */
export interface PageMapEntry {
	/** The URL of the page (`/about/history/`, `/a.html`). */
	readonly url: string;
	/** The source file; `null` for a virtual page, which has none. */
	readonly inputPath: string | null;
	/**
	 * Where the page is written. A virtual page is not written; this is where it would be, for
	 * a map of where every page is expected to be.
	 */
	readonly outputPath: string;
	/** The file name without its extension; the name of the directory for an `index`. */
	readonly fileSlug: string;
	/** The path from the site root without the extension (`/about/index`). */
	readonly filePathStem: string;
	/** The extension of the source (`.html`, `.tsx`); `null` for a virtual page. */
	readonly extension: string | null;
	/**
	 * The number of directories above the page, plus one unless the page is the index of its
	 * directory: `/` is 0, `/about/` and `/a.html` are 1, `/about/history/` and
	 * `/about/history.html` are 2 (the depth of `nav()`'s tree). A file name with `?`, `#` or `\`
	 * is counted by the segments of the URL as written, where the tree reads the URL as a URL
	 * and counts it differently (RFC §14.1).
	 */
	readonly depth: number;
	/**
	 * The URL of the directory the page hangs from; `null` for the root. Whether a page exists
	 * at that URL is for the reader to look up.
	 */
	readonly parent: string | null;
	/** Declared in `pages.overrides` without an input file. */
	readonly virtual: boolean;
	/** The metadata of every source, merged (RFC §4). */
	readonly meta: Record<string, unknown>;
}

/**
 * What `pages()` returns.
 * @example
 * ```ts
 * const map: PageMap = await pages('/site/kamado.config.jsonc');
 * const virtuals = map.pages.filter((page) => page.virtual);
 * ```
 */
export interface PageMap {
	readonly version: 1;
	/** In the order of `pages` and `nav()`: the meta `order` places a page among its siblings (RFC section 6). */
	readonly pages: readonly PageMapEntry[];
	/** The warnings of the plan (`outputPathConflict`, a plan cache that could not be written). */
	readonly warnings: readonly string[];
}

/**
 * The text of the map, as the core wrote it (compact JSON). The CLI writes it as it is; `pages()` reads it.
 * @param configPath - Absolute path of the config file
 * @param options - Plan switches
 * @returns The JSON text of a {@link PageMap}
 * @throws {Error} on a configuration or plan error, or when `options` has a key that is not in
 * {@link PAGES_OPTION_KEYS} (`unknown option: <key>`)
 * @example
 * ```ts
 * const text = pagesJson('/site/kamado.config.jsonc', { incremental: true });
 * ```
 */
export function pagesJson(configPath: string, options: PagesOptions = {}): string {
	assertKnownOptions(options, PAGES_OPTION_KEYS);
	return native().pages(
		configPath,
		JSON.stringify({ incremental: options.incremental, cacheDir: options.cacheDir }),
	);
}

/**
 * Lists the pages of the site described by `configPath` (an absolute path to
 * `kamado.config.jsonc`), planned and not rendered: one entry for each page of the plan, with
 * its URL, its files, its place in the tree of directories and its merged `meta`. It is the
 * list `kamado pages` writes (RFC §14.1), and costs what planning costs: no page is rendered,
 * so it does not wait for a build. `targets` does not apply; every page of the plan is listed.
 *
 * The plan is one synchronous call of the core, so the event loop is blocked while it runs
 * (about a second and a half for 100,000 pages when the plan cache is warm, longer when it is
 * not): the promise is the shape of `build()`, not a promise that the loop stays free.
 * @param configPath - Absolute path of the config file
 * @param options - Plan switches
 * @returns The map
 * @throws {Error} on a configuration or plan error (an unreadable `pages.overrides`, a `meta` that
 * cannot be read without running the file, ...), or when `options` has a key that is not in
 * {@link PAGES_OPTION_KEYS} (`unknown option: <key>`)
 * @example
 * ```ts
 * const map = await pages('/site/kamado.config.jsonc', { incremental: true });
 * for (const page of map.pages.filter((p) => p.depth <= 2)) {
 * 	console.log(page.url, page.meta.title);
 * }
 * ```
 */
export function pages(configPath: string, options: PagesOptions = {}): Promise<PageMap> {
	// The plan is one synchronous call of the core. The promise is the shape of `build()`, and
	// an error of the core is a rejection, not a throw before the caller can `catch` it.
	return Promise.try(() => JSON.parse(pagesJson(configPath, options)) as PageMap);
}
