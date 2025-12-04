import path from 'node:path';

/**
 * Converts directory path to absolute path
 * @param dir - Directory path (relative or absolute)
 * @param rootDir - Root directory (used for resolving relative paths)
 * @returns Absolute path (undefined if dir is undefined)
 */
export function toAbsolutePath(
	dir: string | undefined,
	rootDir: string,
): string | undefined {
	if (!dir) {
		return undefined;
	}
	if (path.isAbsolute(dir)) {
		return dir;
	}
	return path.resolve(rootDir, dir);
}
