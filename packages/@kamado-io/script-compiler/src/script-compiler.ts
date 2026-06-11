import type { CustomCompileFunction, SourcemapOption } from 'kamado/compiler';
import type { CreateBanner } from 'kamado/compiler/banner';
import type { MetaData } from 'kamado/files';

import path from 'node:path';

import {
	createBannerResolver,
	createCacheDigest,
	createCustomCompiler,
	resolveSourcemapFlag,
} from 'kamado/compiler';
import { trackDependency } from 'kamado/files';

/**
 * Options for the script compiler
 */
export interface ScriptCompilerOptions {
	/**
	 * Map of path aliases
	 * Key is alias name, value is actual path
	 */
	readonly alias?: Record<string, string>;
	/**
	 * Whether to enable minification
	 */
	readonly minifier?: boolean;
	/**
	 * Banner configuration
	 * Can specify CreateBanner function or string
	 */
	readonly banner?: CreateBanner | string;
	/**
	 * Emit an inline source map (data URI appended as `//# sourceMappingURL=...`).
	 *
	 * - `true` / `false`: always emit / never emit.
	 * - `'onServer'`: emit only when kamado runs in serve mode (`context.mode === 'serve'`).
	 *
	 * Default: `'onServer'`.
	 */
	readonly sourcemap?: SourcemapOption;
}

/**
 * Script compiler
 * Bundles JavaScript/TypeScript files with esbuild and adds a banner before compiling.
 * @example
 * ```typescript
 * const config = {
 *   compilers: (def) => [
 *     def(createScriptCompiler(), {
 *       alias: { '@': './src' },
 *       minifier: true,
 *       banner: 'Generated file',
 *     }),
 *   ],
 * };
 * ```
 */
export function createScriptCompiler<M extends MetaData>() {
	return createCustomCompiler<ScriptCompilerOptions, M>(() => ({
		defaultFiles: '**/*.{js,ts,jsx,tsx,mjs,cjs}',
		defaultOutputExtension: '.js',
		compile: (options) => async (context) => {
			/**
			 * When loading kamado.config.ts via getConfig(cosmiconfig),
			 * if that kamado.config.ts invokes this compiler,
			 * and getConfig is executed with --experimental-strip-types enabled,
			 * using a static import for esbuild will cause a special runtime error.
			 */
			const esbuild = await import('esbuild');

			const resolveBanner = createBannerResolver(options?.banner);
			const enableSourcemap = resolveSourcemapFlag(options?.sourcemap, context.mode);

			const compileFunction: CustomCompileFunction = async (file, _, __, cache) => {
				const banner = resolveBanner(cache);
				// write: false keeps the bundle in memory — no tmp-file round-trip;
				// metafile records every bundled input for the incremental manifest
				const result = await esbuild.build({
					entryPoints: [file.inputPath],
					bundle: true,
					alias: options?.alias,
					outfile: file.outputPath,
					write: false,
					metafile: true,
					minify: options?.minifier,
					charset: 'utf8',
					sourcemap: enableSourcemap ? 'inline' : false,
					banner: {
						js: banner,
					},
				});
				// esbuild resolves imports itself, outside kamado's file APIs, so
				// report every bundled input for the incremental-build manifest
				// (metafile paths are relative to the working directory)
				for (const input of Object.keys(result.metafile?.inputs ?? {})) {
					trackDependency(path.resolve(input));
				}

				// outputFiles order is not guaranteed (e.g. extracted CSS or
				// sourcemaps come alongside the bundle) — select by output path
				const expectedPath = path.resolve(file.outputPath);
				const outputFile = result.outputFiles.find(
					(output) => path.resolve(output.path) === expectedPath,
				);
				if (!outputFile) {
					throw new Error(`esbuild produced no output for ${file.inputPath}`);
				}
				for (const output of result.outputFiles) {
					if (output === outputFile) {
						continue;
					}
					// eslint-disable-next-line no-console
					console.warn(
						`Ignoring additional esbuild output '${output.path}' for ${file.inputPath}`,
					);
				}
				return outputFile.text;
			};

			// Context-level inputs for the incremental-build manifest: when any
			// of these change, every script must be rebuilt (functions in options
			// are omitted from the digest — banner is captured as its resolved
			// string instead)
			compileFunction.cacheDigest = () =>
				createCacheDigest({
					compiler: '@kamado-io/script-compiler',
					options,
					banner: resolveBanner(),
					enableSourcemap,
				});

			return compileFunction;
		},
	}));
}
