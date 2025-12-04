import path from 'node:path';

/**
 *
 * @param dir
 * @param rootDir
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
