import type { ComputeOutputPathContext, OutputPathInfo } from './types.js';

import path from 'node:path';

/**
 * Computes output file path and related information from input file path
 * @param context - Required context (inputPath, inputDir, outputDir, outputExtension)
 * @returns Output path information object
 * @example
 * ```typescript
 * const info = computeOutputPath({
 *   inputPath: './src/pages/index.pug',
 *   inputDir: './src',
 *   outputDir: './dist',
 *   outputExtension: '.html',
 * });
 * // Returns: {
 * //   outputPath: '/absolute/path/to/dist/pages/index.html',
 * //   name: 'index',
 * //   extension: '.pug',
 * //   relDir: 'pages',
 * //   rootRelPath: 'pages/index',
 * //   rootRelPathWithExt: 'pages/index.html'
 * // }
 * ```
 */
export function computeOutputPath(context: ComputeOutputPathContext): OutputPathInfo {
	const { inputPath, inputDir, outputDir, outputExtension } = context;
	const originalExtension = path.extname(inputPath);
	const extension = originalExtension.toLowerCase();
	const name = path.basename(inputPath, originalExtension);
	const dir = path.dirname(inputPath);
	const relDir = path.relative(inputDir, dir);
	const rootRelPath = path.join(relDir, name);
	const rootRelPathWithExt = `${rootRelPath}${outputExtension}`;
	const outputPath = path.resolve(outputDir, rootRelPathWithExt);

	return {
		outputPath,
		name,
		extension,
		relDir,
		rootRelPath,
		rootRelPathWithExt,
	};
}
