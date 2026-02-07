import { vol, fs as memfs } from 'memfs';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import { mergeConfig } from '../config/merge-config.js';

import { getGlobalData } from './get-global-data.js';

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

describe('getAssetGroup with virtual file system', async () => {
	const config = await mergeConfig({
		pkg: { name: 'mock' },
		dir: {
			root: '/mock/',
			input: '/mock/input/dir',
			output: '/mock/output/',
		},
	});

	beforeEach(() => {
		vol.fromJSON({
			'/mock/input/dir/index.html':
				'<html><head><title>Content of Index page</title></head><body>Index</body></html>',
			'/mock/input/dir/contact.pug': 'p Contact page',
			'/mock/input/dir/subdir/page.html':
				'<html><head><title>Content of Page</title></head><body>Page</body></html>',
			'/mock/input/dir/style.css': 'body { background-color: #fff; }',
			'/mock/input/dir/script.js': 'console.log("Hello, world!");',
			'/mock/input/data/data1.yml': 'name: John',
			'/mock/input/data/data2.json': '{"name": "John"}',
		});
	});

	afterEach(() => {
		vol.reset();
	});

	test('use no compiler', async () => {
		const configWithCompilers = {
			...config,
			compilers: () => [
				{
					files: '**/*.{html,pug}',
					outputExtension: '.html',
					compiler: () => () => '',
				},
			],
		};
		const globalData = await getGlobalData('/mock/input/data', configWithCompilers);

		expect(globalData.data1.name).toBe('John');
		expect(globalData.data2.name).toBe('John');

		expect(
			globalData.pageAssetFiles.map((page) => {
				// @ts-ignore
				delete page.date;
				// @ts-ignore
				delete page.get;
				return page;
			}),
		).toStrictEqual([
			{
				extension: '.pug',
				filePathStem: '/contact',
				fileSlug: 'contact',
				inputPath: '/mock/input/dir/contact.pug',
				outputPath: '/mock/output/contact.html',
				url: '/contact.html',
			},
			{
				extension: '.html',
				filePathStem: '/index',
				fileSlug: 'dir',
				inputPath: '/mock/input/dir/index.html',
				outputPath: '/mock/output/index.html',
				url: '/',
			},
			{
				extension: '.html',
				filePathStem: '/subdir/page',
				fileSlug: 'page',
				inputPath: '/mock/input/dir/subdir/page.html',
				outputPath: '/mock/output/subdir/page.html',
				url: '/subdir/page.html',
			},
		]);

		// title is now optional - kamado no longer auto-populates titles
		// Users should set titles via config.pageList hook, or page-compiler will handle fallback
		expect(globalData.pageList.map((page) => page.title)).toStrictEqual([
			undefined,
			undefined,
			undefined,
		]);
	});
});
