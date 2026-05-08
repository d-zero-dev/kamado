import path from 'node:path';

import { vol, fs as memfs } from 'memfs';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import { clearFileContentCache } from '../files/file-content.js';

import { getCompilableFileMap } from './map.js';

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

describe('getCompilableFileMap', () => {
	beforeEach(() => {
		clearFileContentCache();
	});

	afterEach(() => {
		vol.reset();
		clearFileContentCache();
	});

	test('keys map by default outputPath when no override', async () => {
		vol.fromJSON({
			'/in/page.html': '<p>X</p>',
		});

		const map = await getCompilableFileMap({
			dir: { input: '/in', output: '/out' },
			compilers: () => [
				{
					files: '**/*.html',
					outputExtension: '.html',
					compiler: () => () => '',
				},
			],
			// @ts-ignore — minimal Config for the helper
		});

		const expectedKey = path.resolve('/out/page.html');
		expect([...map.keys()]).toStrictEqual([expectedKey]);
		expect(map.get(expectedKey)?.inputPath).toBe('/in/page.html');
	});

	test('keys map by overridden outputPath when outputPathField is set', async () => {
		vol.fromJSON({
			'/in/page.html': '---\npath: /custom/landing.html\n---\n<p>X</p>',
		});

		const map = await getCompilableFileMap({
			dir: { input: '/in', output: '/out' },
			compilers: () => [
				{
					files: '**/*.html',
					outputExtension: '.html',
					outputPathField: 'path',
					compiler: () => () => '',
				},
			],
			// @ts-ignore
		});

		const overriddenKey = path.resolve('/out/custom/landing.html');
		expect([...map.keys()]).toStrictEqual([overriddenKey]);
		expect(map.get(overriddenKey)?.inputPath).toBe('/in/page.html');
		expect(map.get(path.resolve('/out/page.html'))).toBeUndefined();
	});

	test('keys map by overridden outputPath for trailing-slash form', async () => {
		vol.fromJSON({
			'/in/about.html': '---\npath: /about/\n---\n<p>About</p>',
		});

		const map = await getCompilableFileMap({
			dir: { input: '/in', output: '/out' },
			compilers: () => [
				{
					files: '**/*.html',
					outputExtension: '.html',
					outputPathField: 'path',
					compiler: () => () => '',
				},
			],
			// @ts-ignore
		});

		const overriddenKey = path.resolve('/out/about/index.html');
		expect(map.has(overriddenKey)).toBe(true);
		expect(map.get(overriddenKey)?.url).toBe('/about/');
	});

	test('preserves keys for files without `path`', async () => {
		vol.fromJSON({
			'/in/page.html': '---\ntitle: Plain\n---\n<p>X</p>',
			'/in/custom.html': '---\npath: /elsewhere.html\n---\n<p>Y</p>',
		});

		const map = await getCompilableFileMap({
			dir: { input: '/in', output: '/out' },
			compilers: () => [
				{
					files: '**/*.html',
					outputExtension: '.html',
					outputPathField: 'path',
					compiler: () => () => '',
				},
			],
			// @ts-ignore
		});

		expect(map.has(path.resolve('/out/page.html'))).toBe(true);
		expect(map.has(path.resolve('/out/elsewhere.html'))).toBe(true);
		expect(map.has(path.resolve('/out/custom.html'))).toBe(false);
	});
});
