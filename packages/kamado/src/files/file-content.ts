import fs from 'node:fs/promises';

const fileContentCache = new Map<string, string>();

/**
 * Gets file content (with caching)
 * @param filePath - File path
 * @returns File content as string
 */
export async function getFileContent(filePath: string): Promise<string> {
	if (fileContentCache.has(filePath)) {
		return fileContentCache.get(filePath)!;
	}
	const fileContent = await fs.readFile(filePath, 'utf8');
	fileContentCache.set(filePath, fileContent);
	return fileContent;
}
