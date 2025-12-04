import type { StyleFunction } from 'ansi-colors';

import path from 'node:path';

import c from 'ansi-colors';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import { filePathColorizer } from './color.js';

describe('filePathColorizer', () => {
	const originalCwd = process.cwd();

	beforeEach(() => {
		// Fix cwd for test consistency
		process.chdir('/');
	});

	afterEach(() => {
		process.chdir(originalCwd);
	});

	test('should throw error for non-absolute path', () => {
		const colorize = filePathColorizer();
		expect(() => colorize('relative/path/file.js')).toThrow(
			'File path is not absolute: relative/path/file.js',
		);
	});

	test('should return exact output for file in root directory', () => {
		const rootDir = '/project';
		const colorize = filePathColorizer({ rootDir });
		const filePath = '/project/index.html';
		const result = colorize(filePath);

		// relRootDir is 'project', so it's included
		const expected = c.dim('project' + path.sep) + c.white('') + c.bold('index.html');
		expect(result).toBe(expected);
	});

	test('should return exact output with directory path', () => {
		const rootDir = '/project';
		const colorize = filePathColorizer({ rootDir });
		const filePath = '/project/src/components/Button.jsx';
		const result = colorize(filePath);

		const expected =
			c.dim('project' + path.sep) +
			c.white('src' + path.sep + 'components' + path.sep) +
			c.bold.yellow('Button.jsx');
		expect(result).toBe(expected);
	});

	test('should use default color for unknown extension', () => {
		const rootDir = '/project';
		const colorize = filePathColorizer({ rootDir });
		const filePath = '/project/src/file.unknown';
		const result = colorize(filePath);

		const expected =
			c.dim('project' + path.sep) + c.white('src' + path.sep) + c.bold('file.unknown');
		expect(result).toBe(expected);
	});

	test('should apply correct colors for .html extension', () => {
		const rootDir = '/project';
		const colorize = filePathColorizer({ rootDir });
		const filePath = '/project/src/file.html';
		const result = colorize(filePath);

		const expected =
			c.dim('project' + path.sep) + c.white('src' + path.sep) + c.bold('file.html');
		expect(result).toBe(expected);
	});

	test('should apply correct colors for .css extension', () => {
		const rootDir = '/project';
		const colorize = filePathColorizer({ rootDir });
		const filePath = '/project/src/file.css';
		const result = colorize(filePath);

		const expected =
			c.dim('project' + path.sep) +
			c.white('src' + path.sep) +
			c.bold.blueBright('file.css');
		expect(result).toBe(expected);
	});

	test('should apply correct colors for .scss extension', () => {
		const rootDir = '/project';
		const colorize = filePathColorizer({ rootDir });
		const filePath = '/project/src/file.scss';
		const result = colorize(filePath);

		const expected =
			c.dim('project' + path.sep) +
			c.white('src' + path.sep) +
			c.bold.blueBright('file.scss');
		expect(result).toBe(expected);
	});

	test('should apply correct colors for .sass extension', () => {
		const rootDir = '/project';
		const colorize = filePathColorizer({ rootDir });
		const filePath = '/project/src/file.sass';
		const result = colorize(filePath);

		const expected =
			c.dim('project' + path.sep) +
			c.white('src' + path.sep) +
			c.bold.blueBright('file.sass');
		expect(result).toBe(expected);
	});

	test('should apply correct colors for .js extension', () => {
		const rootDir = '/project';
		const colorize = filePathColorizer({ rootDir });
		const filePath = '/project/src/file.js';
		const result = colorize(filePath);

		const expected =
			c.dim('project' + path.sep) + c.white('src' + path.sep) + c.bold.yellow('file.js');
		expect(result).toBe(expected);
	});

	test('should apply correct colors for .mjs extension', () => {
		const rootDir = '/project';
		const colorize = filePathColorizer({ rootDir });
		const filePath = '/project/src/file.mjs';
		const result = colorize(filePath);

		const expected =
			c.dim('project' + path.sep) + c.white('src' + path.sep) + c.bold.yellow('file.mjs');
		expect(result).toBe(expected);
	});

	test('should apply correct colors for .cjs extension', () => {
		const rootDir = '/project';
		const colorize = filePathColorizer({ rootDir });
		const filePath = '/project/src/file.cjs';
		const result = colorize(filePath);

		const expected =
			c.dim('project' + path.sep) + c.white('src' + path.sep) + c.bold.yellow('file.cjs');
		expect(result).toBe(expected);
	});

	test('should apply correct colors for .jsx extension', () => {
		const rootDir = '/project';
		const colorize = filePathColorizer({ rootDir });
		const filePath = '/project/src/file.jsx';
		const result = colorize(filePath);

		const expected =
			c.dim('project' + path.sep) + c.white('src' + path.sep) + c.bold.yellow('file.jsx');
		expect(result).toBe(expected);
	});

	test('should apply correct colors for .json extension', () => {
		const rootDir = '/project';
		const colorize = filePathColorizer({ rootDir });
		const filePath = '/project/src/file.json';
		const result = colorize(filePath);

		const expected =
			c.dim('project' + path.sep) +
			c.white('src' + path.sep) +
			c.bold.magenta('file.json');
		expect(result).toBe(expected);
	});

	test('should apply correct colors for .svg extension', () => {
		const rootDir = '/project';
		const colorize = filePathColorizer({ rootDir });
		const filePath = '/project/src/file.svg';
		const result = colorize(filePath);

		const expected =
			c.dim('project' + path.sep) + c.white('src' + path.sep) + c.bold.red('file.svg');
		expect(result).toBe(expected);
	});

	test('should handle custom colors', () => {
		const mockUnderDir = vi.fn(
			(text: string) => `[underDir]${text}`,
		) as unknown as StyleFunction;
		const mockDir = vi.fn((text: string) => `[dir]${text}`) as unknown as StyleFunction;
		const mockName = vi.fn((text: string) => `[name]${text}`) as unknown as StyleFunction;
		const colorize = filePathColorizer({
			rootDir: '/project',
			colors: {
				underDir: mockUnderDir,
				dir: mockDir,
				name: {
					default: mockName,
					'.js': mockName, // Use custom color for .js extension too
				},
			},
		});
		const filePath = '/project/src/file.js';
		const result = colorize(filePath);

		expect(result).toBe('[underDir]project/' + '[dir]src/' + '[name]file.js');
		expect(mockUnderDir).toHaveBeenCalledWith('project/');
		expect(mockDir).toHaveBeenCalledWith('src/');
		expect(mockName).toHaveBeenCalledWith('file.js');
	});

	test('should handle custom name colors for specific extensions', () => {
		const mockDefault = vi.fn(
			(text: string) => `[default]${text}`,
		) as unknown as StyleFunction;
		const mockJs = vi.fn((text: string) => `[js]${text}`) as unknown as StyleFunction;
		const colorize = filePathColorizer({
			rootDir: '/project',
			colors: {
				name: {
					default: mockDefault,
					'.js': mockJs,
				},
			},
		});
		const jsFilePath = '/project/src/file.js';
		const unknownFilePath = '/project/src/file.unknown';

		const jsResult = colorize(jsFilePath);
		const unknownResult = colorize(unknownFilePath);

		expect(jsResult).toBe(c.dim('project/') + c.white('src/') + '[js]file.js');
		expect(unknownResult).toBe(
			c.dim('project/') + c.white('src/') + '[default]file.unknown',
		);
		expect(mockJs).toHaveBeenCalledWith('file.js');
		expect(mockDefault).toHaveBeenCalledWith('file.unknown');
	});

	test('should handle nested directories', () => {
		const rootDir = '/project';
		const colorize = filePathColorizer({ rootDir });
		const filePath = '/project/src/components/ui/Button.jsx';
		const result = colorize(filePath);

		const expected =
			c.dim('project' + path.sep) +
			c.white('src' + path.sep + 'components' + path.sep + 'ui' + path.sep) +
			c.bold.yellow('Button.jsx');
		expect(result).toBe(expected);
	});

	test('should handle file without extension', () => {
		const rootDir = '/project';
		const colorize = filePathColorizer({ rootDir });
		const filePath = '/project/src/file';
		const result = colorize(filePath);

		const expected =
			c.dim('project' + path.sep) + c.white('src' + path.sep) + c.bold('file');
		expect(result).toBe(expected);
	});

	test('should handle case-insensitive extension matching', () => {
		const rootDir = '/project';
		const colorize = filePathColorizer({ rootDir });
		const upperCasePath = '/project/src/FILE.JS';
		const lowerCasePath = '/project/src/file.js';
		const resultUpper = colorize(upperCasePath);
		const resultLower = colorize(lowerCasePath);

		const expectedUpper =
			c.dim('project' + path.sep) + c.white('src' + path.sep) + c.bold.yellow('FILE.JS');
		const expectedLower =
			c.dim('project' + path.sep) + c.white('src' + path.sep) + c.bold.yellow('file.js');
		expect(resultUpper).toBe(expectedUpper);
		expect(resultLower).toBe(expectedLower);
	});

	test('should handle file in current working directory', () => {
		const colorize = filePathColorizer();
		const cwd = process.cwd();
		const filePath = path.join(cwd, 'file.js');
		const result = colorize(filePath);

		// Since cwd is '/', relRootDir becomes an empty string
		const expected = c.bold.yellow('file.js');
		expect(result).toBe(expected);
	});

	test('should handle file outside rootDir', () => {
		const rootDir = '/project';
		const colorize = filePathColorizer({ rootDir });
		const filePath = '/other/file.js';
		const result = colorize(filePath);

		expect(result).toBe(c.white('other/') + c.bold.yellow('file.js'));
	});
});
