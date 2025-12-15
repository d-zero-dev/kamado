import type { StyleFunction } from 'ansi-colors';

import path from 'node:path';

import c from 'ansi-colors';

import { splitPath } from '../path/split-path.js';

type ColorsNames = {
	readonly default?: StyleFunction;
	readonly [ext: `.${string}`]: StyleFunction;
};

/**
 * Generates a function to colorize file paths
 * @param options - Options for colorization
 * @param options.rootDir - Root directory
 * @param options.cwd - Current working directory
 * @param options.enable - Whether to enable colorization
 * @param options.colors - Color settings
 * @param options.colors.underDir - Color for paths above root directory
 * @param options.colors.dir - Color for directory names
 * @param options.colors.name - Color for file names (configurable per extension)
 * @returns Function that takes a file path and returns colorized string
 * @throws {Error} if the returned function is called with a non-absolute file path
 * @example
 * ```typescript
 * const colorize = filePathColorizer({
 *   rootDir: './src',
 *   colors: {
 *     dir: c.cyan,
 *     name: { '.ts': c.yellow, '.js': c.green },
 *   },
 * });
 * const colored = colorize('/path/to/file.ts');
 * ```
 */
export function filePathColorizer(options?: {
	readonly rootDir: string;
	readonly cwd?: string;
	readonly enable?: boolean;
	readonly colors?: {
		readonly underDir?: StyleFunction;
		readonly dir?: StyleFunction;
		readonly name?: ColorsNames;
	};
}) {
	const colorsUnderDir = options?.colors?.underDir ?? c.dim;
	const colorsDir = options?.colors?.dir ?? c.white;
	const colorsNames: Required<ColorsNames> = {
		default: c.bold,
		'.html': c.bold,
		'.pug': c.bold,
		'.css': c.bold.blueBright,
		'.scss': c.bold.blueBright,
		'.sass': c.bold.blueBright,
		'.js': c.bold.yellow,
		'.mjs': c.bold.yellow,
		'.cjs': c.bold.yellow,
		'.jsx': c.bold.yellow,
		'.ts': c.bold.yellow,
		'.tsx': c.bold.yellow,
		'.json': c.bold.magenta,
		'.svg': c.bold.red,
		...options?.colors?.name,
	};

	return (filePath: string) => {
		if (!path.isAbsolute(filePath)) {
			throw new Error(`File path is not absolute: ${filePath}`);
		}

		const { fromCwd, fromBase, name, ext } = splitPath(
			filePath,
			options?.rootDir,
			options?.cwd,
		);

		const colorsName =
			colorsNames[ext.toLowerCase() as `.${string}`] ?? colorsNames.default;
		return (
			(fromCwd ? colorsUnderDir(fromCwd + path.sep) : '') +
			(fromBase ? colorsDir(fromBase + path.sep) : '') +
			colorsName(name + ext)
		);
	};
}
