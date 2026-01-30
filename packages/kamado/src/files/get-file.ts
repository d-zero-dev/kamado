import type { CompilableFile, GetFileOptions } from './types.js';

import path from 'node:path';

import grayMatter from 'gray-matter';

import { computeOutputPath } from '../path/output-path.js';

import { getFileContent } from './file-content.js';

/**
 * Creates a CompilableFile object from a file path
 * @param filePath - File path
 * @param options - Options for getting the file
 * @param options.inputDir - Input directory path
 * @param options.outputDir - Output directory path
 * @param options.outputExtension - Output file extension (e.g., '.html', '.css', '.js')
 * @returns CompilableFile object
 * @example
 * ```typescript
 * const file = getFile('./src/pages/index.pug', {
 *   inputDir: './src',
 *   outputDir: './dist',
 *   outputExtension: '.html',
 * });
 * ```
 */
export function getFile(filePath: string, options: GetFileOptions): CompilableFile {
	const pathInfo = computeOutputPath(
		filePath,
		options.inputDir,
		options.outputDir,
		options.outputExtension,
	);

	const filePathStem = '/' + pathInfo.rootRelPath.replaceAll(path.sep, '/');
	const url =
		'/' +
		pathInfo.rootRelPathWithExt
			.replaceAll(path.sep, '/')
			.replace(/(?<=\/|^)index(?:\.[a-z]+)?$/, '');

	const dir = path.dirname(filePath);

	return {
		inputPath: filePath,
		outputPath: pathInfo.outputPath,
		fileSlug: pathInfo.name === 'index' ? path.basename(dir) : pathInfo.name,
		filePathStem,
		extension: pathInfo.extension,
		date: new Date(),
		url,
		/**
		 * Gets file content
		 * @param cache - Whether to cache the file content (default: true)
		 * @returns File content
		 */
		async get(cache = true) {
			const dir = path.dirname(filePath);
			const ext = path.extname(filePath);
			const name = path.basename(filePath, ext);
			const jsonFilePath = path.join(dir, `${name}.json`);
			const jsonContent = await getFileContent(jsonFilePath, cache).catch(() => null);
			const jsonData = jsonContent ? JSON.parse(jsonContent) : {};
			const raw = await getFileContent(filePath, cache);
			const { data, content } = grayMatter(raw);
			return {
				metaData: {
					...data,
					...jsonData,
				},
				content,
				raw,
			};
		},
	};
}
