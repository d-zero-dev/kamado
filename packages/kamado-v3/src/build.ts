import type { RenderContext } from './props.js';
import type { Rendered, RenderJob } from './render.js';

import { native } from './native.js';
import { renderJobs } from './render.js';
import { RUNTIME_URL } from './runtime-url.js';
import {
	buildScripts,
	ESBUILD_VERSION,
	findEsbuildBinary,
	type ScriptRequest,
} from './scripts.js';

/**
 * The frames `feed` takes: a little-endian `u32` page, a `u32` byte length
 * and the UTF-8 bytes of the HTML, for each page.
 * @param rendered - Pages and their HTML
 */
function frames(rendered: readonly Rendered[]): Buffer {
	const lengths = rendered.map(([, html]) => Buffer.byteLength(html, 'utf8'));
	let size = 0;
	for (const length of lengths) {
		size += 8 + length;
	}
	const buffer = Buffer.allocUnsafe(size);
	let at = 0;
	for (const [i, [page, html]] of rendered.entries()) {
		const length = lengths[i]!;
		buffer.writeUInt32LE(page, at);
		buffer.writeUInt32LE(length, at + 4);
		buffer.write(html, at + 8, length, 'utf8');
		at += 8 + length;
	}
	return buffer;
}

/** Build-time switches; every field is optional and defaults to the config. */
export interface BuildOptions {
	readonly incremental?: boolean;
	readonly force?: boolean;
	readonly skipUnchanged?: boolean;
	/** Globs relative to the input directory; only matching pages are built. */
	readonly targets?: readonly string[];
	readonly jobs?: number;
	readonly cacheDir?: string;
	/**
	 * Called as pages are rendered with the number done and the number to
	 * render (not part of the options the core is given).
	 */
	readonly onProgress?: (done: number, total: number) => void;
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
	const timing = process.env['KAMADO_TIMING'] === '1';
	const started = performance.now();
	const lap = (what: string) => {
		if (timing) {
			// eslint-disable-next-line no-console
			console.error(
				`  ${what}: ${Math.round(performance.now() - started)}ms (since start)`,
			);
		}
	};
	const { onProgress, ...coreOptions } = options;
	const prepared = JSON.parse(
		core.prepare(
			configPath,
			JSON.stringify({
				...coreOptions,
				// The banner's dates are local time, which the core cannot tell.
				tzOffsetMinutes: -new Date().getTimezoneOffset(),
				esbuildVersion: ESBUILD_VERSION,
				esbuildBinary: findEsbuildBinary(),
			}),
			RUNTIME_URL,
		),
	) as Prepared;
	lap(`prepared (${prepared.jobs.length} jobs)`);
	try {
		// Pages render in worker threads while esbuild bundles the scripts. The
		// HTML goes to the core as each batch is done, not after the last one.
		let done = 0;
		const [, scripts] = await Promise.all([
			prepared.context && prepared.jobs.length > 0
				? renderJobs(prepared.jobs, prepared.context, {
						runtimeUrl: RUNTIME_URL,
						parallelism: options.jobs,
						onRendered: (rendered) => {
							core.feed(prepared.handle, frames(rendered));
							done += rendered.length;
							onProgress?.(done, prepared.jobs.length);
						},
					})
				: [],
			prepared.scripts ? buildScripts(prepared.scripts) : [],
		]);
		lap('rendered');
		const results = JSON.stringify({ scripts });
		lap('serialized');
		const report = JSON.parse(core.finish(prepared.handle, results)) as BuildReport;
		lap('finished');
		return report;
	} catch (error) {
		core.abort(prepared.handle);
		throw error;
	}
}
