import type { FileContent, FileObject } from './types.js';

import { getFileContent } from './file-content.js';

/**
 * Gets file content from a FileObject (simple read)
 * @param file - FileObject to get content from
 * @param cache - Whether to cache the file content (default: true)
 * @returns File content with empty metadata
 */
export async function getContentFromFileObject(
	file: FileObject,
	cache = true,
): Promise<FileContent> {
	const content = await getFileContent(file.inputPath, cache);
	return {
		metaData: {},
		content,
		raw: content,
	};
}
