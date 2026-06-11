import fs from 'node:fs/promises';

import { trackDependency } from './dependency-tracker.js';

const fileContentCache = new Map<string, string>();

/**
 * Gets file content (with caching)
 * @param filePath - File path
 * @param cache - Whether to cache the file content (default: true)
 * @returns File content as string
 */
export async function getFileContent(filePath: string, cache = true): Promise<string> {
	// Even a cache hit is a read for dependency-tracking purposes: the
	// compilation's output depends on this file regardless of where the
	// bytes came from
	trackDependency(filePath);
	if (cache && fileContentCache.has(filePath)) {
		return fileContentCache.get(filePath)!;
	}
	const fileContent = await fs.readFile(filePath, 'utf8');
	if (cache) {
		fileContentCache.set(filePath, fileContent);
	}
	return fileContent;
}

/**
 * Clears the file content cache
 * Useful for freeing memory after build completion or resetting state
 */
export function clearFileContentCache(): void {
	fileContentCache.clear();
}
