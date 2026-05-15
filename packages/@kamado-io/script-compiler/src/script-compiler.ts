import type { CreateBanner } from 'kamado/compiler/banner';
import type { MetaData } from 'kamado/files';

import fs from 'node:fs/promises';
import os from 'node:os';
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
	/**
	 * Emit an inline source map (data URI appended as `//# sourceMappingURL=...`).
	 *
	 * - `true` / `false`: always emit / never emit.
	 * - `'onServer'`: emit only when kamado runs in serve mode (`context.mode === 'serve'`).
	 *
	 * Default: false.
	 */
	readonly sourcemap?: boolean | 'onServer';
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

			// `context.mode` is fixed for the lifetime of a command, so evaluate
			// the sourcemap flag once here rather than per-file.
			const enableSourcemap =
				options?.sourcemap === 'onServer'
					? context.mode === 'serve'
					: !!options?.sourcemap;

			return async (file) => {
				const banner =
					typeof options?.banner === 'string'
						? options.banner
						: createBanner(options?.banner?.());
				const tmpFilePath = path.join(os.tmpdir(), file.outputPath);
				await esbuild.build({
					entryPoints: [file.inputPath],
					bundle: true,
					alias: options?.alias,
					outfile: tmpFilePath,
					minify: options?.minifier,
					charset: 'utf8',
					sourcemap: enableSourcemap ? 'inline' : false,
					banner: {
						js: banner,
					},
				});
				return await fs.readFile(tmpFilePath, 'utf8');
			};
		},
	}));
}
