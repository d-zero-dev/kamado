import type { CompilableFile, FileContent, MetaData } from './types.js';

import path from 'node:path';

import grayMatter from 'gray-matter';

import { getFileContent } from './file-content.js';

/**
 * Gets file content from a CompilableFile
 * Merges front matter and same-name JSON file metadata
 * @param file - CompilableFile to get content from
 * @param cache - Whether to cache the file content (default: true)
 * @returns File content with metadata, content, and raw content
 */
export async function getContentFromFile<M extends MetaData>(
	file: CompilableFile,
	cache = true,
): Promise<FileContent & { metaData: M }> {
	const filePath = file.inputPath;
	const dir = path.dirname(filePath);
	const ext = path.extname(filePath);
	const name = path.basename(filePath, ext);
	const jsonFilePath = path.join(dir, `${name}.json`);

	const jsonContent = await getFileContent(jsonFilePath, cache).catch(() => null);
	let jsonData: Record<string, unknown> = {};
	if (jsonContent) {
		try {
			jsonData = JSON.parse(jsonContent) as Record<string, unknown>;
		} catch {
			throw new Error(`Failed to parse JSON metadata file: ${jsonFilePath}`);
		}
	}
	const raw = await getFileContent(filePath, cache);
	const { data, content } = grayMatter(raw);

	return {
		metaData: { ...data, ...jsonData } as M,
		content,
		raw,
	};
}
