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
 *
 * @param filePath
 * @param options
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
 *
 * @param outputFileType
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
