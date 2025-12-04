import path from 'node:path';

/**
 *
 * @param filePath
 * @param baseDir
 * @param cwd
 */
export function splitPath(filePath: string, baseDir?: string, cwd = process.cwd()) {
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
