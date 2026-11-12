import path from 'node:path';

import { buildFrom } from './build-from.js';

/** Build-time switches; every field is optional and defaults to the config. */
export interface BuildOptions {
	readonly incremental?: boolean;
	readonly force?: boolean;
	readonly skipUnchanged?: boolean;
	/**
	 * Renders every page that this build rendered once more (not the pages it kept from an
	 * earlier build), each in a worker of its own, and fails the build when the HTML differs
	 * (RFC section 11). A failed build writes no manifest. Slow on a big site: render a part of
	 * it with `targets`. It finds a page whose output depends
	 * on something the build did not record, such as the data a page kept in a variable of
	 * a module.
	 * @example
	 * ```ts
	 * await build('/site/kamado.config.jsonc', { verifyDeps: true });
	 * ```
	 */
	readonly verifyDeps?: boolean;
	/**
	 * Only the pages, stylesheets and scripts whose input file matches are
	 * built. A relative entry is relative to the directory of the config file
	 * (to the cwd from the CLI); an absolute one is used without a base. An
	 * entry with a glob character (`*` `?` `[` `]` `{` `}`) is a glob; any other
	 * entry is a path: a directory stands for every file under it, and a path
	 * that does not exist is an error. An entry that selects no page,
	 * stylesheet or script is a warning of the report. A negated glob (`!a/**`)
	 * is an error.
	 * @example
	 * ```ts
	 * await build('/site/kamado.config.jsonc', { targets: ['src/css/style.css', 'src/news/**'] });
	 * ```
	 */
	readonly targets?: readonly string[];
	readonly jobs?: number;
	/**
	 * Where the build manifest and the plan cache are kept. A relative path is relative to
	 * the directory of the config file (the command line's `--cache-dir` is relative to the
	 * cwd, so the same relative path names another cache there); an absolute one is used as
	 * it is. The default is a directory of `os.tmpdir()` named after the project.
	 * @example
	 * ```ts
	 * await build('/site/kamado.config.jsonc', { incremental: true, cacheDir: '.cache' }); // /site/.cache
	 * ```
	 */
	readonly cacheDir?: string;
	/**
	 * Called as pages are rendered with the number done and the number to
	 * render (not part of the options the core is given).
	 */
	readonly onProgress?: (done: number, total: number) => void;
}

/**
 * Keys {@link build} / {@link buildFrom} read. Kept next to {@link BuildOptions} so a new
 * field is either allowed here or refused as `unknown option`.
 * @example
 * ```ts
 * assertKnownOptions({ incremental: true }, BUILD_OPTION_KEYS);
 * ```
 */
export const BUILD_OPTION_KEYS = [
	'incremental',
	'force',
	'skipUnchanged',
	'verifyDeps',
	'targets',
	'jobs',
	'cacheDir',
	'onProgress',
] as const satisfies readonly (keyof BuildOptions)[];

export type PageStatus = 'built' | 'cached' | 'unchanged' | 'skipped' | 'virtual';

export interface PageResult {
	readonly url: string;
	readonly inputPath: string;
	readonly outputPath: string;
	readonly status: PageStatus;
	readonly meta: Record<string, unknown>;
}

export interface AssetResult {
	readonly kind: 'style' | 'script';
	readonly inputPath: string;
	readonly outputPath: string;
	readonly status: PageStatus;
}

export interface BuildReport {
	readonly version: 1;
	readonly pages: readonly PageResult[];
	readonly assets: readonly AssetResult[];
	readonly warnings: readonly string[];
	readonly elapsedMs: number;
	/**
	 * Why a page that an earlier build wrote was built again, as `[url, reason]` (for
	 * `--verbose`). Absent when no page has one, as in a first build.
	 * @example
	 * ```ts
	 * report.reasons; // [['/news/', 'data.posts changed']]
	 * ```
	 */
	readonly reasons?: readonly (readonly [string, string])[];
	/**
	 * What was decided about each data file that is a script (it ran, with the time and the
	 * first characters of the hash of its value; the value and anything it was made from are
	 * never in it), for `--verbose`. Absent when the site has none.
	 * @example
	 * ```ts
	 * report.data; // ['data news: ran (231ms, hash a1b2c3d4)']
	 * ```
	 */
	readonly data?: readonly string[];
}

/**
 * Builds the site described by `configPath` (an absolute path to
 * `kamado.config.jsonc`). Errors from the core are thrown as `Error`.
 * Relative entries of `targets` are relative to the directory of the config
 * file, as the paths in the config are.
 *
 * The core plans the build and compiles the JSX modules; the pages that need
 * JavaScript (JSX pages, pages with a layout) are rendered here, in worker
 * threads when there are many; the core takes the HTML back for its own
 * stages and writes the outputs.
 * @param configPath - Absolute path of the config file
 * @param options - Build switches
 * @returns The build report
 * @throws {Error} when an entry of `targets` is a path that does not exist or a negated glob, or
 * when `options` has a key that is not in {@link BUILD_OPTION_KEYS} (`unknown option: <key>`)
 * @example
 * ```ts
 * const report = await build('/site/kamado.config.jsonc', { incremental: true });
 * console.log(report.pages.filter((p) => p.status === 'built').length);
 * // Only /site/src/news/** (relative to the directory of the config file)
 * await build('/site/kamado.config.jsonc', { targets: ['src/news/**'] });
 * ```
 */
export async function build(
	configPath: string,
	options: BuildOptions = {},
): Promise<BuildReport> {
	return buildFrom(configPath, options, path.dirname(configPath));
}
