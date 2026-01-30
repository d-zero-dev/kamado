import { vol, fs as memfs } from 'memfs';
import {
	describe,
	test,
	expect,
	beforeEach,
	afterEach,
	vi,
	beforeAll,
	afterAll,
} from 'vitest';

import { mergeConfig } from '../config/merge-config.js';

import { build } from './build.js';

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

let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
const originalCwd = process.cwd();

beforeAll(() => {
	process.chdir('/');
	consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterAll(() => {
	process.chdir(originalCwd);
	consoleLogSpy.mockRestore();
	stdoutWriteSpy.mockRestore();
});

describe('getAssetGroup with virtual file system', async () => {
	const config = await mergeConfig(
		// @ts-ignore
		{ pkg: { name: 'mock' } },
	);

	beforeEach(() => {
		vol.fromJSON({
			'/mock/input/dir/index.html': '<html><body>Index</body></html>',
			'/mock/input/dir/contact.pug': 'p Contact page',
			'/mock/input/dir/subdir/page.html': '<html><body>Page</body></html>',
			'/mock/input/dir/style.css': 'body { background-color: #fff; }',
			'/mock/input/dir/script.js': 'console.log("Hello, world!");',
		});
	});

	afterEach(() => {
		vol.reset();
	});

	test('use no compiler', async () => {
		await build({
			...config,
			dir: {
				...config.dir,
				input: '/mock/input/dir',
				output: '/mock/output/dir',
			},
			compilers: [],
			verbose: true,
		});

		// When compilers array is empty, no files are built
		expect(vol.toJSON()).toStrictEqual({
			'/mock/input/dir/contact.pug': 'p Contact page',
			'/mock/input/dir/index.html': '<html><body>Index</body></html>',
			'/mock/input/dir/script.js': 'console.log("Hello, world!");',
			'/mock/input/dir/style.css': 'body { background-color: #fff; }',
			'/mock/input/dir/subdir/page.html': '<html><body>Page</body></html>',
		});
	}, 10_000);

	test('use compiler', async () => {
		await build({
			...config,
			dir: {
				...config.dir,
				input: '/mock/input/dir',
				output: '/mock/output/dir',
			},
			compilers: [
				{
					files: '**/*.{html,pug}',
					outputExtension: '.html',
					compiler: () => () => 'page content',
				},
				{
					files: '**/*.css',
					outputExtension: '.css',
					compiler: () => () => 'style content',
				},
				{
					files: '**/*.js',
					outputExtension: '.js',
					compiler: () => () => 'script content',
				},
			],
			verbose: true,
		});

		expect(vol.toJSON()).toStrictEqual({
			'/mock/input/dir/contact.pug': 'p Contact page',
			'/mock/input/dir/index.html': '<html><body>Index</body></html>',
			'/mock/input/dir/script.js': 'console.log("Hello, world!");',
			'/mock/input/dir/style.css': 'body { background-color: #fff; }',
			'/mock/input/dir/subdir/page.html': '<html><body>Page</body></html>',
			'/mock/output/dir/contact.html': 'page content',
			'/mock/output/dir/index.html': 'page content',
			'/mock/output/dir/script.js': 'script content',
			'/mock/output/dir/style.css': 'style content',
			'/mock/output/dir/subdir/page.html': 'page content',
		});
	}, 10_000);
});
