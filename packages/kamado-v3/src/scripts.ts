/**
 * Builds the scripts the core asks for with esbuild (RFC section 8). The core
 * decides which scripts are stale and what the options are; this module only
 * runs the bundler and reports every file it read, so the core can record
 * them as the dependencies of the output.
 *
 * Why esbuild stays in JavaScript: bundling, TypeScript and the module
 * resolution of `node_modules` are its job, and its output is what v2 users
 * already ship.
 */
import path from 'node:path';

import * as esbuild from 'esbuild';

/** The version of esbuild; a different one rebuilds every script. */
export const ESBUILD_VERSION: string = esbuild.version;

/** What the core asks for (`scripts` of `prepare`). */
export interface ScriptRequest {
	readonly root: string;
	readonly options: {
		readonly alias: Record<string, string>;
		readonly define: Record<string, string>;
		readonly target: string;
		readonly minify: boolean;
		readonly sourcemap: boolean;
		/** The banner comment, or `null` when disabled. */
		readonly banner: string | null;
	};
	readonly entries: readonly {
		readonly id: number;
		readonly input: string;
		readonly output: string;
	}[];
}

/** What goes back to the core for one script. */
export interface ScriptOutput {
	readonly id: number;
	readonly code: string;
	/** Absolute paths of every input that was bundled. */
	readonly inputs: readonly string[];
}

/** Bundles are built this many at a time. */
const CONCURRENCY = 8;

/**
 * Builds the requested scripts.
 * @param request - The scripts and the shared options
 * @returns One result per entry, in the order of the entries
 * @throws {Error} with esbuild's message when a script fails to build
 * @example
 * ```ts
 * const outputs = await buildScripts({
 *   root: '/site',
 *   options: { alias: {}, define: {}, target: 'es2022', minify: true, sourcemap: false, banner: null },
 *   entries: [{ id: 0, input: '/site/src/app.ts', output: '/site/htdocs/app.js' }],
 * });
 * ```
 */
export async function buildScripts(request: ScriptRequest): Promise<ScriptOutput[]> {
	const { root, options, entries } = request;
	const results: ScriptOutput[] = Array.from({ length: entries.length });
	let next = 0;
	const worker = async () => {
		for (let i = next++; i < entries.length; i = next++) {
			const entry = entries[i]!;
			const result = await esbuild.build({
				absWorkingDir: root,
				entryPoints: [entry.input],
				bundle: true,
				alias: options.alias,
				define: options.define,
				target: options.target,
				outfile: entry.output,
				// In memory: the core writes the file (and skips it when unchanged).
				write: false,
				metafile: true,
				minify: options.minify,
				charset: 'utf8',
				sourcemap: options.sourcemap ? 'inline' : false,
				...(options.banner === null ? {} : { banner: { js: options.banner } }),
				// An error is thrown with its message; esbuild must not print it too.
				logLevel: 'silent',
			});
			if (result.warnings.length > 0) {
				const lines = await esbuild.formatMessages(result.warnings, {
					kind: 'warning',
					color: false,
				});
				// eslint-disable-next-line no-console
				console.warn(lines.join('\n').trimEnd());
			}
			// Further outputs (extracted CSS, source maps) are not part of the
			// contract: a script is exactly one file.
			const expected = path.resolve(entry.output);
			const file = result.outputFiles.find((o) => path.resolve(o.path) === expected);
			if (!file) {
				throw new Error(`esbuild produced no output for ${entry.input}`);
			}
			results[i] = {
				id: entry.id,
				code: file.text,
				// The metafile's paths are relative to the working directory.
				inputs: Object.keys(result.metafile.inputs).map((input) =>
					path.resolve(root, input),
				),
			};
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(CONCURRENCY, entries.length) }, () => worker()),
	);
	return results;
}
