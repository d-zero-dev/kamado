/**
 * The build itself, behind `build()` and the CLI. Not exported from the
 * package: the two differ only in the directory the relative entries of
 * `targets` are relative to, which the CLI (the cwd) and `build()` (the
 * directory of the config file) pass in.
 */
import type { BuildOptions, BuildReport } from './build.js';
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
import { resolveTargets } from './targets.js';

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
 * Builds the site of `configPath` with the relative entries of `targets`
 * resolved from `targetBase` (see `build()` for the rest). The input files are
 * named from `configPath` and the globs from `targetBase`, in the form they
 * are given: the two must name the directories the same way (the CLI gives
 * both as real paths).
 * @param configPath - Absolute path of the config file
 * @param options - Build switches
 * @param targetBase - The directory a relative entry of `targets` is relative to
 * @returns The build report
 * @throws {Error} when an entry of `targets` is a path that does not exist or a negated glob
 * @example
 * ```ts
 * // `kamado build src/css/style.css`, typed in /site
 * const report = await buildFrom('/site/kamado.config.jsonc', { targets: ['src/css/style.css'] }, '/site');
 * ```
 */
export async function buildFrom(
	configPath: string,
	options: BuildOptions,
	targetBase: string,
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
	const targets =
		options.targets === undefined
			? undefined
			: resolveTargets(options.targets, targetBase);
	const prepared = JSON.parse(
		core.prepare(
			configPath,
			JSON.stringify({
				...coreOptions,
				...(targets === undefined ? {} : { targets }),
				// The banner's dates are local time, which the core cannot tell.
				tzOffsetMinutes: 0 - new Date().getTimezoneOffset(),
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
