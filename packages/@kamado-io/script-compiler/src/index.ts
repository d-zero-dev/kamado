import fs from 'node:fs/promises';

import esbuild from 'esbuild';
import { createCompiler } from 'kamado/compiler';
import { createBanner, type CreateBanner } from 'kamado/compiler/banner';

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
 *   compilers: {
 *     script: scriptCompiler({
 *       alias: { '@': './src' },
 *       minifier: true,
 *       banner: 'Generated file',
 *     }),
 *   },
 * };
 * ```
 */
export const scriptCompiler = createCompiler<ScriptCompilerOptions>((options) => () => {
	return async (file) => {
		const banner =
			typeof options?.banner === 'string'
				? options.banner
				: createBanner(options?.banner?.());
		await esbuild.build({
			entryPoints: [file.inputPath],
			bundle: true,
			alias: options?.alias,
			outfile: file.outputPath,
			minify: options?.minifier,
			charset: 'utf8',
			banner: {
				js: banner,
			},
		});
		return await fs.readFile(file.outputPath, 'utf8');
	};
});
