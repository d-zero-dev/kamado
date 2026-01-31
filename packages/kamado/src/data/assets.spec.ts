import { vol, fs as memfs } from 'memfs';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import { getAssetGroup } from './get-asset-group.js';

vi.mock('fast-glob', async () => {
	const actual = await vi.importActual('fast-glob');
	return {
		default: async (pattern: string) => {
			// @ts-ignore
			const matchedFiles = await actual.default(pattern, {
				cwd: '/',
				absolute: true,
				// @ts-ignore
				fs: memfs,
				onlyFiles: true,
			});
			return matchedFiles;
		},
	};
});

vi.mock('node:fs/promises', () => {
	return {
		default: memfs.promises,
	};
});

describe('getAssetGroup with virtual file system', () => {
	beforeEach(() => {
		vol.fromJSON({
			'/mock/input/dir/index.html': '<html><body>Index</body></html>',
			'/mock/input/dir/about.html': '<html><body>About</body></html>',
			'/mock/input/dir/contact.pug': 'p Contact page',
			'/mock/input/dir/subdir/page.html': '<html><body>Page</body></html>',
			'/mock/input/dir/style.css': 'body { background-color: #fff; }',
			'/mock/input/dir/script.js': 'console.log("Hello, world!");',
		});
	});

	afterEach(() => {
		vol.reset();
	});

	test('should return page files', async () => {
		const result = await getAssetGroup({
			inputDir: '/mock/input/dir',
			outputDir: '/mock/output/dir',
			compilerEntry: {
				files: '**/*.{html,pug}',
				outputExtension: '.html',
				compiler: () => () => '',
			},
		});

		expect(result.map((f) => f.inputPath).toSorted()).toStrictEqual([
			'/mock/input/dir/about.html',
			'/mock/input/dir/contact.pug',
			'/mock/input/dir/index.html',
			'/mock/input/dir/subdir/page.html',
		]);

		expect(result[0]).toHaveProperty('inputPath', '/mock/input/dir/about.html');
		expect(result[0]).toHaveProperty('outputPath', '/mock/output/dir/about.html');
		expect(result[0]).toHaveProperty('fileSlug', 'about');
		expect(result[0]).toHaveProperty('filePathStem', '/about');
		expect(result[0]).toHaveProperty('extension', '.html');
	});

	test('should filter files with glob option (AND condition)', async () => {
		const result = await getAssetGroup(
			{
				inputDir: '/mock/input/dir',
				outputDir: '/mock/output/dir',
				compilerEntry: {
					files: '**/*.{html,pug}',
					outputExtension: '.html',
					compiler: () => () => '',
				},
			},
			{ glob: '**/index.*' },
		);

		expect(result.map((f) => f.inputPath)).toStrictEqual(['/mock/input/dir/index.html']);
	});

	test('should filter files with glob option matching specific directory', async () => {
		const result = await getAssetGroup(
			{
				inputDir: '/mock/input/dir',
				outputDir: '/mock/output/dir',
				compilerEntry: {
					files: '**/*.{html,pug}',
					outputExtension: '.html',
					compiler: () => () => '',
				},
			},
			{ glob: '**/subdir/**' },
		);

		expect(result.map((f) => f.inputPath)).toStrictEqual([
			'/mock/input/dir/subdir/page.html',
		]);
	});

	test('should return empty array when glob matches no files', async () => {
		const result = await getAssetGroup(
			{
				inputDir: '/mock/input/dir',
				outputDir: '/mock/output/dir',
				compilerEntry: {
					files: '**/*.{html,pug}',
					outputExtension: '.html',
					compiler: () => () => '',
				},
			},
			{ glob: '**/nonexistent.*' },
		);

		expect(result).toStrictEqual([]);
	});
});
