import type { CompilableFile, ExtensionOutputTypeMap, OutputFileType } from './types.js';

import path from 'node:path';

import grayMatter from 'gray-matter';

import { getFileContent } from './file-content.js';

interface GetFileOptions {
	readonly inputDir: string;
	readonly outputDir: string;
	readonly extensions: ExtensionOutputTypeMap;
}

/**
 * Creates a CompilableFile object from a file path
 * @param filePath - File path
 * @param options - Options for getting the file
 * @param options.inputDir - Input directory path
 * @param options.outputDir - Output directory path
 * @param options.extensions - Mapping of extensions to output file types
 * @returns CompilableFile object
 * @throws Error if the file type is not supported (not found in extensions mapping)
 * @example
 * ```typescript
 * const file = getFile('./src/pages/index.pug', {
 *   inputDir: './src',
 *   outputDir: './dist',
 *   extensions: { pug: 'page', html: 'page' },
 * });
 * ```
 */
export function getFile(filePath: string, options: GetFileOptions): CompilableFile {
	const extension = path.extname(filePath).toLowerCase();
	const name = path.basename(filePath, extension);
	const dir = path.dirname(filePath);
	const relDir = path.relative(options.inputDir, dir);
	const rootRelPath = path.join(relDir, name);
	const filePathStem = '/' + rootRelPath.replaceAll(path.sep, '/');
	const fileType = extension.slice(1);
	const outputFileType: OutputFileType =
		// @ts-ignore
		options.extensions[fileType] ?? '#error';
	const outputExtension = detectOutputExtension(outputFileType);
	const rootRelPathWithExt = `${rootRelPath}${outputExtension}`;
	const url =
		'/' +
		rootRelPathWithExt
			.replaceAll(path.sep, '/')
			.replace(/(?<=\/|^)index(?:\.[a-z]+)?$/, '');

	if (outputFileType === '#error') {
		throw new Error(`Unsupported file type: ${fileType}`);
	}

	return {
		inputPath: filePath,
		outputPath: path.resolve(options.outputDir, rootRelPathWithExt),
		fileSlug: name === 'index' ? path.basename(dir) : name,
		filePathStem,
		extension,
		outputFileType,
		date: new Date(),
		url,
		async get() {
			const dir = path.dirname(filePath);
			const ext = path.extname(filePath);
			const name = path.basename(filePath, ext);
			const jsonFilePath = path.join(dir, `${name}.json`);
			const jsonContent = await getFileContent(jsonFilePath).catch(() => null);
			const jsonData = jsonContent ? JSON.parse(jsonContent) : {};
			const raw = await getFileContent(filePath);
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

/**
 * Detects output file extension based on output file type
 * @param outputFileType - Output file type
 * @returns File extension string (e.g., '.html', '.css', '.js', or empty string)
 */
function detectOutputExtension(outputFileType: OutputFileType) {
	switch (outputFileType) {
		case 'page': {
			return '.html';
		}
		case 'style': {
			return '.css';
		}
		case 'script': {
			return '.js';
		}
		default: {
			return '';
		}
	}
}
