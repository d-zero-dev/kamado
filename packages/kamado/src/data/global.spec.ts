import { vol, fs as memfs } from 'memfs';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import { mergeConfig } from '../config/merge-config.js';
import { clearFileContentCache } from '../files/file-content.js';

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

describe("getGlobalData honors frontmatter 'path' override", async () => {
	const config = await mergeConfig({
		pkg: { name: 'mock' },
		dir: {
			root: '/mock/',
			input: '/mock/input/dir',
			output: '/mock/output/',
		},
	});

	beforeEach(() => {
		clearFileContentCache();
		vol.fromJSON({
			'/mock/input/dir/landing.html':
				'---\npath: /docs/getting-started/\n---\n<p>Landing</p>',
			'/mock/input/dir/plain.html': '<p>Plain</p>',
		});
	});

	afterEach(() => {
		vol.reset();
		clearFileContentCache();
	});

	test('pageAssetFiles and pageList expose the overridden url/outputPath', async () => {
		const configWithCompilers = {
			...config,
			compilers: () => [
				{
					files: '**/*.html',
					outputExtension: '.html',
					outputPathField: 'path',
					compiler: () => () => '',
				},
			],
		};
		const globalData = await getGlobalData('', configWithCompilers);

		const byInput = (input: string) =>
			globalData.pageAssetFiles.find((page) => page.inputPath === input);

		expect(byInput('/mock/input/dir/landing.html')?.outputPath).toBe(
			'/mock/output/docs/getting-started/index.html',
		);
		expect(byInput('/mock/input/dir/landing.html')?.url).toBe('/docs/getting-started/');
		expect(byInput('/mock/input/dir/plain.html')?.outputPath).toBe(
			'/mock/output/plain.html',
		);

		// pageList shares the same overridden objects when no pageList hook is given
		expect(globalData.pageList).toBe(globalData.pageAssetFiles);
	});

	test('pageList hook receives the overridden CompilableFile objects', async () => {
		const seen: { inputPath: string; url: string; outputPath: string }[] = [];
		const configWithHook = {
			...config,
			compilers: () => [
				{
					files: '**/*.html',
					outputExtension: '.html',
					outputPathField: 'path',
					compiler: () => () => '',
				},
			],
			pageList: (pages) => {
				for (const page of pages) {
					seen.push({
						inputPath: page.inputPath,
						url: page.url,
						outputPath: page.outputPath,
					});
				}
				return pages;
			},
		} satisfies typeof config;

		await getGlobalData('', configWithHook);

		expect(seen).toContainEqual({
			inputPath: '/mock/input/dir/landing.html',
			url: '/docs/getting-started/',
			outputPath: '/mock/output/docs/getting-started/index.html',
		});
	});
});
