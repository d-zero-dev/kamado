import path from 'node:path';

/**
 * Resolves array of paths and glob patterns and converts to comma-separated string
 * @param pathsAndGlobs - Array of paths or glob patterns
 * @param baseDir - Base directory (used for resolving relative paths)
 * @returns Comma-separated string of resolved paths (undefined if empty)
 * @example
 * ```typescript
 * pathResolver(['./src/pages/*.pug', './layouts'], './project');
 * // Returns: "/project/src/pages/*.pug,/project/layouts"
 * ```
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
