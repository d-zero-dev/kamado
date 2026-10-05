import type { RenderContext } from './props.js';

import { native } from './native.js';
import { renderJobs, type RenderJob } from './render.js';
import {
	buildScripts,
	ESBUILD_VERSION,
	findEsbuildBinary,
	type ScriptRequest,
} from './scripts.js';

/** Build-time switches; every field is optional and defaults to the config. */
export interface BuildOptions {
	readonly incremental?: boolean;
	readonly force?: boolean;
	readonly skipUnchanged?: boolean;
	/** Globs relative to the input directory; only matching pages are built. */
	readonly targets?: readonly string[];
	readonly jobs?: number;
	readonly cacheDir?: string;
}

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
}

/** What `prepare` of the core returns. */
interface Prepared {
	readonly handle: string;
	readonly jobs: readonly RenderJob[];
	/** `null` when there is nothing to render. */
	readonly context: RenderContext | null;
	/** `null` when no script is stale. */
	readonly scripts: ScriptRequest | null;
}

/** File URL of the JSX runtime that compiled modules import. */
const RUNTIME_URL = new URL('jsx/runtime.js', import.meta.url).href;

/**
 * Builds the site described by `configPath` (an absolute path to
 * `kamado.config.jsonc`). Errors from the core are thrown as `Error`.
 *
 * The core plans the build and compiles the JSX modules; the pages that need
 * JavaScript (JSX pages, pages with a layout) are rendered here, in worker
 * threads when there are many; the core takes the HTML back for its own
 * stages and writes the outputs.
 * @param configPath - Absolute path of the config file
 * @param options - Build switches
 * @returns The build report
 * @example
 * ```ts
 * const report = await build('/site/kamado.config.jsonc', { incremental: true });
 * console.log(report.pages.filter((p) => p.status === 'built').length);
 * ```
 */
export async function build(
	configPath: string,
	options: BuildOptions = {},
): Promise<BuildReport> {
	const core = native();
	const prepared = JSON.parse(
		core.prepare(
			configPath,
			JSON.stringify({
				...options,
				// The banner's dates are local time, which the core cannot tell.
				tzOffsetMinutes: -new Date().getTimezoneOffset(),
				esbuildVersion: ESBUILD_VERSION,
				esbuildBinary: findEsbuildBinary(),
			}),
			RUNTIME_URL,
		),
	) as Prepared;
	try {
		// Pages render in worker threads while esbuild bundles the scripts.
		const [pages, scripts] = await Promise.all([
			prepared.context && prepared.jobs.length > 0
				? renderJobs(prepared.jobs, prepared.context, {
						runtimeUrl: RUNTIME_URL,
						parallelism: options.jobs,
					})
				: [],
			prepared.scripts ? buildScripts(prepared.scripts) : [],
		]);
		return JSON.parse(
			core.finish(prepared.handle, JSON.stringify({ pages, scripts })),
		) as BuildReport;
	} catch (error) {
		core.abort(prepared.handle);
		throw error;
	}
}
