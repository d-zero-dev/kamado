import type { SplitPathInfo } from './types.js';

import path from 'node:path';

/**
 * Splits file path and gets relative path information
 * @param filePath - Absolute file path
 * @param baseDir - Base directory (defaults to cwd if omitted)
 * @param cwd - Current working directory (defaults to process.cwd())
 * @returns Path information object
 * @throws {Error} if filePath is not absolute
 */
export function splitPath(
	filePath: string,
	baseDir?: string,
	cwd = process.cwd(),
): SplitPathInfo {
	if (!path.isAbsolute(filePath)) {
		throw new Error(`File path is not absolute: ${filePath}`);
	}
	baseDir = baseDir ?? cwd;

	const ext = path.extname(filePath) as `.${string}`;
	const name = path.basename(filePath, ext);
	const dir = path.dirname(filePath);

	let fromBase = path.relative(baseDir, dir);
	let fromCwd = path.relative(cwd, baseDir);
	if (fromBase.startsWith('..')) {
		fromBase = path.join(fromCwd, fromBase);
		fromCwd = '';
	}

	return {
		fromCwd,
		fromBase,
		name,
		ext,
	};
}
