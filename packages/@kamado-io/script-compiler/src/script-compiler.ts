import type { CreateBanner } from 'kamado/compiler/banner';
import type { MetaData } from 'kamado/files';

import path from 'node:path';

import { createCustomCompiler } from 'kamado/compiler';
import { createBanner } from 'kamado/compiler/banner';

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
		compile: (options) => async () => {
			/**
			 * When loading kamado.config.ts via getConfig(cosmiconfig),
			 * if that kamado.config.ts invokes this compiler,
			 * and getConfig is executed with --experimental-strip-types enabled,
			 * using a static import for esbuild will cause a special runtime error.
			 */
			const esbuild = await import('esbuild');

			const resolveBanner = () =>
				typeof options?.banner === 'string'
					? options.banner
					: createBanner(options?.banner?.());
			// Banner is file-independent; build once per context. Serve mode
			// (cache === false) recomputes so date-based banners stay fresh
			let cachedBanner: string | undefined;

			return async (file, _, __, cache) => {
				const banner =
					cache === false ? resolveBanner() : (cachedBanner ??= resolveBanner());
				// write: false keeps the bundle in memory — no tmp-file round-trip
				const result = await esbuild.build({
					entryPoints: [file.inputPath],
					bundle: true,
					alias: options?.alias,
					outfile: file.outputPath,
					write: false,
					minify: options?.minifier,
					charset: 'utf8',
					banner: {
						js: banner,
					},
				});
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
		},
	}));
}
