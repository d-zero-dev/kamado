import path from 'node:path';

/**
 *
 * @param pathsAndGlobs
 * @param baseDir
 */
export function pathResolver(pathsAndGlobs?: string[], baseDir?: string) {
	return (
		pathsAndGlobs
			?.map((inputPath) =>
				path.isAbsolute(inputPath)
					? inputPath
					: path.resolve(baseDir ?? process.cwd(), inputPath),
			)
			.join(',') || undefined
	);
}
