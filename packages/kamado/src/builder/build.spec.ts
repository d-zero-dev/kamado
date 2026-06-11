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
import { getFileContent } from '../files/file-content.js';
import { getContentFromFile } from '../files/get-content-from-file.js';

import { getBuildManifestPath } from './build-manifest.js';
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
			compilers: () => [],
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
			compilers: () => [
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

describe('build with skipUnchanged', async () => {
	const config = await mergeConfig(
		// @ts-ignore
		{ pkg: { name: 'mock' } },
	);

	beforeEach(() => {
		vol.fromJSON({
			'/mock/input/dir/index.html': '<html><body>Index</body></html>',
		});
	});

	afterEach(() => {
		vol.reset();
	});

	test('skips rewriting outputs whose content is unchanged', async () => {
		const buildConfig = {
			...config,
			dir: {
				...config.dir,
				input: '/mock/input/dir',
				output: '/mock/output/dir',
			},
			compilers: () => [
				{
					files: '**/*.html',
					outputExtension: '.html',
					compiler: () => () => 'page content',
				},
			],
			skipUnchanged: true,
			verbose: true,
		};

		await build(buildConfig);
		expect(vol.toJSON()['/mock/output/dir/index.html']).toBe('page content');

		const writeFileSpy = vi.spyOn(memfs.promises, 'writeFile');
		await build(buildConfig);
		expect(writeFileSpy).not.toHaveBeenCalled();
		writeFileSpy.mockRestore();
	}, 10_000);

	test('writes outputs when content changes but the size stays the same', async () => {
		const makeBuildConfig = (content: string) => ({
			...config,
			dir: {
				...config.dir,
				input: '/mock/input/dir',
				output: '/mock/output/dir',
			},
			compilers: () => [
				{
					files: '**/*.html',
					outputExtension: '.html',
					compiler: () => () => content,
				},
			],
			skipUnchanged: true,
			verbose: true,
		});

		// 'aaa' and 'bbb' have identical byte lengths — this must defeat the
		// stat-size fast path and fall through to the content comparison
		await build(makeBuildConfig('aaa'));

		const writeFileSpy = vi.spyOn(memfs.promises, 'writeFile');
		await build(makeBuildConfig('bbb'));
		expect(writeFileSpy).toHaveBeenCalled();
		writeFileSpy.mockRestore();

		expect(vol.toJSON()['/mock/output/dir/index.html']).toBe('bbb');
	}, 10_000);

	test('skips unchanged ArrayBuffer outputs', async () => {
		const makeBuildConfig = () => ({
			...config,
			dir: {
				...config.dir,
				input: '/mock/input/dir',
				output: '/mock/output/dir',
			},
			compilers: () => [
				{
					files: '**/*.html',
					outputExtension: '.html',
					compiler: () => () => new TextEncoder().encode('binary content').buffer,
				},
			],
			skipUnchanged: true,
			verbose: true,
		});

		// @ts-ignore
		await build(makeBuildConfig());
		expect(vol.toJSON()['/mock/output/dir/index.html']).toBe('binary content');

		const writeFileSpy = vi.spyOn(memfs.promises, 'writeFile');
		// @ts-ignore
		await build(makeBuildConfig());
		expect(writeFileSpy).not.toHaveBeenCalled();
		writeFileSpy.mockRestore();
	}, 10_000);

	test('writes outputs when content changes', async () => {
		const makeBuildConfig = (content: string) => ({
			...config,
			dir: {
				...config.dir,
				input: '/mock/input/dir',
				output: '/mock/output/dir',
			},
			compilers: () => [
				{
					files: '**/*.html',
					outputExtension: '.html',
					compiler: () => () => content,
				},
			],
			skipUnchanged: true,
			verbose: true,
		});

		await build(makeBuildConfig('first content'));

		const writeFileSpy = vi.spyOn(memfs.promises, 'writeFile');
		await build(makeBuildConfig('second content'));
		expect(writeFileSpy).toHaveBeenCalled();
		writeFileSpy.mockRestore();

		expect(vol.toJSON()['/mock/output/dir/index.html']).toBe('second content');
	}, 10_000);
});

describe('consecutive builds in the same process', async () => {
	const config = await mergeConfig(
		// @ts-ignore
		{ pkg: { name: 'mock' } },
	);

	afterEach(() => {
		vol.reset();
	});

	test('reflects files added between builds on the next build', async () => {
		vol.fromJSON({
			'/mock/input/dir/index.html': '<p>A</p>',
		});
		const buildConfig = {
			...config,
			dir: {
				...config.dir,
				input: '/mock/input/dir',
				output: '/mock/output/dir',
			},
			compilers: () => [
				{
					files: '**/*.html',
					outputExtension: '.html',
					compiler: () => () => 'page content',
				},
			],
			verbose: true,
		};

		await build(buildConfig);
		expect(vol.toJSON()['/mock/output/dir/added.html']).toBeUndefined();

		// Add a new source file, then build again in the same process. The
		// asset-group memoization must not survive into the second build —
		// removing clearAssetGroupCache() from clearBuildCaches() fails here
		vol.fromJSON({
			'/mock/input/dir/added.html': '<p>B</p>',
		});
		await build(buildConfig);
		expect(vol.toJSON()['/mock/output/dir/added.html']).toBe('page content');
	}, 10_000);

	test('reflects source file edits on the next build', async () => {
		vol.fromJSON({
			'/mock/input/dir/index.html': '<p>ORIGINAL</p>',
		});
		const buildConfig = {
			...config,
			dir: {
				...config.dir,
				input: '/mock/input/dir',
				output: '/mock/output/dir',
			},
			compilers: () => [
				{
					files: '**/*.html',
					outputExtension: '.html',
					// Reads the actual source content so that stale file-content
					// caching between builds would surface here
					compiler:
						() =>
						async (
							file: { inputPath: string },
							_: unknown,
							__: unknown,
							cache?: boolean,
						) => {
							// @ts-ignore
							const fileContent = await getContentFromFile(file, cache);
							return fileContent.content;
						},
				},
			],
			verbose: true,
		};

		// @ts-ignore
		await build(buildConfig);
		expect(vol.toJSON()['/mock/output/dir/index.html']).toBe('<p>ORIGINAL</p>');

		// Edit the source file, then build again in the same process
		vol.fromJSON({
			'/mock/input/dir/index.html': '<p>EDITED</p>',
		});
		// @ts-ignore
		await build(buildConfig);
		expect(vol.toJSON()['/mock/output/dir/index.html']).toBe('<p>EDITED</p>');
	}, 10_000);
});

describe("build with frontmatter 'path' override", async () => {
	const config = await mergeConfig(
		// @ts-ignore
		{ pkg: { name: 'mock' } },
	);

	beforeEach(() => {
		vol.fromJSON({
			'/mock/input/dir/explicit.html':
				'---\npath: /custom/landing.html\n---\n<p>Explicit</p>',
			'/mock/input/dir/no-ext.html': '---\npath: /custom/no-ext\n---\n<p>NoExt</p>',
			'/mock/input/dir/dir.html': '---\npath: /section/\n---\n<p>Section</p>',
			'/mock/input/dir/plain.html': '<p>Plain</p>',
		});
	});

	afterEach(() => {
		vol.reset();
	});

	test('writes pages to overridden paths', async () => {
		await build({
			...config,
			dir: {
				...config.dir,
				input: '/mock/input/dir',
				output: '/mock/output/dir',
			},
			compilers: () => [
				{
					files: '**/*.html',
					outputExtension: '.html',
					outputPathField: 'path',
					compiler: () => (file) => `compiled:${file.inputPath}`,
				},
			],
			verbose: true,
		});

		const outputs = Object.fromEntries(
			Object.entries(vol.toJSON()).filter(([key]) => key.startsWith('/mock/output')),
		);
		expect(outputs).toStrictEqual({
			'/mock/output/dir/custom/landing.html': 'compiled:/mock/input/dir/explicit.html',
			'/mock/output/dir/custom/no-ext.html': 'compiled:/mock/input/dir/no-ext.html',
			'/mock/output/dir/section/index.html': 'compiled:/mock/input/dir/dir.html',
			'/mock/output/dir/plain.html': 'compiled:/mock/input/dir/plain.html',
		});
	}, 10_000);
});

describe('incremental builds', async () => {
	const config = await mergeConfig(
		// @ts-ignore
		{ pkg: { name: 'mock' } },
	);

	afterEach(() => {
		vol.reset();
	});

	/**
	 * Compiler that reads the source through kamado's file APIs, so the
	 * dependency tracker records the input file
	 * @param compileSpy
	 */
	const makeReadingCompiler = (compileSpy: ReturnType<typeof vi.fn>) => ({
		files: '**/*.html',
		outputExtension: '.html',
		compiler: () => compileSpy,
	});

	const makeBuildConfig = (compileSpy: ReturnType<typeof vi.fn>) => ({
		...config,
		dir: {
			...config.dir,
			input: '/mock/input/dir',
			output: '/mock/output/dir',
		},
		compilers: () => [makeReadingCompiler(compileSpy)],
		incremental: true,
		verbose: true,
	});

	const readingCompileSpy = () =>
		vi.fn(async (file: { inputPath: string }) => {
			// @ts-ignore
			const fileContent = await getContentFromFile(file);
			return `compiled:${fileContent.content}`;
		});

	test('skips recompiling when inputs are unchanged', async () => {
		vol.fromJSON({
			'/mock/input/dir/index.html': '<p>A</p>',
		});
		const compileSpy = readingCompileSpy();

		// @ts-ignore
		await build(makeBuildConfig(compileSpy));
		expect(compileSpy).toHaveBeenCalledTimes(1);
		expect(vol.toJSON()['/mock/output/dir/index.html']).toBe('compiled:<p>A</p>');

		// @ts-ignore
		await build(makeBuildConfig(compileSpy));
		expect(compileSpy).toHaveBeenCalledTimes(1);
		expect(vol.toJSON()['/mock/output/dir/index.html']).toBe('compiled:<p>A</p>');
	}, 10_000);

	test('recompiles when the input file changes', async () => {
		vol.fromJSON({
			'/mock/input/dir/index.html': '<p>A</p>',
		});
		const compileSpy = readingCompileSpy();

		// @ts-ignore
		await build(makeBuildConfig(compileSpy));

		vol.fromJSON({
			'/mock/input/dir/index.html': '<p>B</p>',
		});
		// @ts-ignore
		await build(makeBuildConfig(compileSpy));
		expect(compileSpy).toHaveBeenCalledTimes(2);
		expect(vol.toJSON()['/mock/output/dir/index.html']).toBe('compiled:<p>B</p>');
	}, 10_000);

	test('recompiles when a sidecar JSON metadata file appears later', async () => {
		// getContentFromFile probes `<name>.json` even when it does not exist;
		// the recorded missing-file dependency must invalidate once it appears
		vol.fromJSON({
			'/mock/input/dir/index.html': '<p>A</p>',
		});
		const compileSpy = readingCompileSpy();

		// @ts-ignore
		await build(makeBuildConfig(compileSpy));
		expect(compileSpy).toHaveBeenCalledTimes(1);

		vol.fromJSON({
			'/mock/input/dir/index.json': '{"title":"T"}',
		});
		// @ts-ignore
		await build(makeBuildConfig(compileSpy));
		expect(compileSpy).toHaveBeenCalledTimes(2);
	}, 10_000);

	test('recompiles when a tracked extra dependency changes', async () => {
		vol.fromJSON({
			'/mock/input/dir/index.html': '<p>A</p>',
			'/mock/shared/snippet.txt': 'v1',
		});
		const compileSpy = vi.fn(async () => {
			const snippet = await getFileContent('/mock/shared/snippet.txt');
			return `compiled:${snippet}`;
		});

		// @ts-ignore
		await build(makeBuildConfig(compileSpy));
		expect(vol.toJSON()['/mock/output/dir/index.html']).toBe('compiled:v1');

		// @ts-ignore
		await build(makeBuildConfig(compileSpy));
		expect(compileSpy).toHaveBeenCalledTimes(1);

		vol.fromJSON({
			'/mock/shared/snippet.txt': 'v2',
		});
		// @ts-ignore
		await build(makeBuildConfig(compileSpy));
		expect(compileSpy).toHaveBeenCalledTimes(2);
		expect(vol.toJSON()['/mock/output/dir/index.html']).toBe('compiled:v2');
	}, 10_000);

	test("recompiles every file when the compiler's cacheDigest changes", async () => {
		vol.fromJSON({
			'/mock/input/dir/index.html': '<p>A</p>',
		});
		let digestSeed = 'env-1';
		const compileSpy = readingCompileSpy();
		const compilerWithDigest = () => {
			const compileFunction = compileSpy as typeof compileSpy & {
				cacheDigest?: () => string;
			};
			compileFunction.cacheDigest = () => digestSeed;
			return compileFunction;
		};
		const buildConfig = {
			...config,
			dir: {
				...config.dir,
				input: '/mock/input/dir',
				output: '/mock/output/dir',
			},
			compilers: () => [
				{
					files: '**/*.html',
					outputExtension: '.html',
					compiler: compilerWithDigest,
				},
			],
			incremental: true,
			verbose: true,
		};

		// @ts-ignore
		await build(buildConfig);
		// @ts-ignore
		await build(buildConfig);
		expect(compileSpy).toHaveBeenCalledTimes(1);

		digestSeed = 'env-2';
		// @ts-ignore
		await build(buildConfig);
		expect(compileSpy).toHaveBeenCalledTimes(2);
	}, 10_000);

	test('never skips a compiler that reads nothing through kamado file APIs', async () => {
		vol.fromJSON({
			'/mock/input/dir/index.html': '<p>A</p>',
		});
		const compileSpy = vi.fn(() => 'constant content');
		const buildConfig = {
			...config,
			dir: {
				...config.dir,
				input: '/mock/input/dir',
				output: '/mock/output/dir',
			},
			compilers: () => [
				{
					files: '**/*.html',
					outputExtension: '.html',
					compiler: () => compileSpy,
				},
			],
			incremental: true,
			verbose: true,
		};

		// @ts-ignore
		await build(buildConfig);
		// @ts-ignore
		await build(buildConfig);
		// No recorded dependencies → nothing to verify against → always recompiled
		expect(compileSpy).toHaveBeenCalledTimes(2);
	}, 10_000);

	test('writes the manifest under dir.root', async () => {
		vol.fromJSON({
			'/mock/input/dir/index.html': '<p>A</p>',
		});
		const compileSpy = readingCompileSpy();

		// @ts-ignore
		await build(makeBuildConfig(compileSpy));

		// build() re-merges the config without rootDir, so dir.root falls back
		// to process.cwd(), which beforeAll sets to '/'
		const manifestRaw = vol.toJSON()[getBuildManifestPath('/')];
		expect(typeof manifestRaw).toBe('string');
		const manifest = JSON.parse(manifestRaw as string);
		expect(Object.keys(manifest.entries)).toStrictEqual(['/mock/output/dir/index.html']);
		expect(manifest.entries['/mock/output/dir/index.html'].inputPath).toBe(
			'/mock/input/dir/index.html',
		);
	}, 10_000);
});
