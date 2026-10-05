import type { RenderContext } from './props.js';

import { native } from './native.js';
import { renderJobs, type RenderJob } from './render.js';

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

export interface BuildReport {
	readonly version: 1;
	readonly pages: readonly PageResult[];
	readonly warnings: readonly string[];
	readonly elapsedMs: number;
}

/** What `prepare` of the core returns. */
interface Prepared {
	readonly handle: string;
	readonly jobs: readonly RenderJob[];
	/** `null` when there is nothing to render. */
	readonly context: RenderContext | null;
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
		core.prepare(configPath, JSON.stringify(options), RUNTIME_URL),
	) as Prepared;
	try {
		const rendered =
			prepared.context && prepared.jobs.length > 0
				? await renderJobs(prepared.jobs, prepared.context, {
						runtimeUrl: RUNTIME_URL,
						parallelism: options.jobs,
					})
				: [];
		return JSON.parse(
			core.finish(prepared.handle, JSON.stringify(rendered)),
		) as BuildReport;
	} catch (error) {
		core.abort(prepared.handle);
		throw error;
	}
}
