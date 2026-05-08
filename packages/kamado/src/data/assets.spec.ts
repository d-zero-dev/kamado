import { vol, fs as memfs } from 'memfs';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import { clearFileContentCache } from '../files/file-content.js';

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

describe("getAssetGroup with frontmatter 'path' override", () => {
	beforeEach(() => {
		clearFileContentCache();
	});

	afterEach(() => {
		vol.reset();
		clearFileContentCache();
	});

	test('honors `path` with explicit extension', async () => {
		vol.fromJSON({
			'/mock/input/dir/source.html': '---\npath: /custom/landing.html\n---\n<p>Hello</p>',
		});

		const result = await getAssetGroup({
			inputDir: '/mock/input/dir',
			outputDir: '/mock/output/dir',
			compilerEntry: {
				files: '**/*.html',
				outputExtension: '.html',
				outputPathField: 'path',
				compiler: () => () => '',
			},
		});

		expect(result).toHaveLength(1);
		expect(result[0]?.outputPath).toBe('/mock/output/dir/custom/landing.html');
		expect(result[0]?.url).toBe('/custom/landing.html');
		expect(result[0]?.filePathStem).toBe('/custom/landing');
		expect(result[0]?.fileSlug).toBe('landing');
	});

	test('honors `path` without extension by appending outputExtension', async () => {
		vol.fromJSON({
			'/mock/input/dir/source.html': '---\npath: /custom/landing\n---\n<p>Hi</p>',
		});

		const result = await getAssetGroup({
			inputDir: '/mock/input/dir',
			outputDir: '/mock/output/dir',
			compilerEntry: {
				files: '**/*.html',
				outputExtension: '.html',
				outputPathField: 'path',
				compiler: () => () => '',
			},
		});

		expect(result[0]?.outputPath).toBe('/mock/output/dir/custom/landing.html');
		expect(result[0]?.url).toBe('/custom/landing.html');
	});

	test('honors `path` with trailing slash by appending index', async () => {
		vol.fromJSON({
			'/mock/input/dir/source.html': '---\npath: /section/\n---\n<p>Section</p>',
		});

		const result = await getAssetGroup({
			inputDir: '/mock/input/dir',
			outputDir: '/mock/output/dir',
			compilerEntry: {
				files: '**/*.html',
				outputExtension: '.html',
				outputPathField: 'path',
				compiler: () => () => '',
			},
		});

		expect(result[0]?.outputPath).toBe('/mock/output/dir/section/index.html');
		expect(result[0]?.url).toBe('/section/');
		expect(result[0]?.filePathStem).toBe('/section/index');
		expect(result[0]?.fileSlug).toBe('section');
	});

	test('ignores `path` when outputPathField is not set', async () => {
		vol.fromJSON({
			'/mock/input/dir/source.html': '---\npath: /custom/landing.html\n---\n<p>Hello</p>',
		});

		const result = await getAssetGroup({
			inputDir: '/mock/input/dir',
			outputDir: '/mock/output/dir',
			compilerEntry: {
				files: '**/*.html',
				outputExtension: '.html',
				compiler: () => () => '',
			},
		});

		expect(result[0]?.outputPath).toBe('/mock/output/dir/source.html');
	});

	test('honors a custom field name (e.g. permalink)', async () => {
		vol.fromJSON({
			'/mock/input/dir/source.html':
				'---\npermalink: /custom/landing.html\npath: /this-is-user-data\n---\n<p>X</p>',
		});

		const result = await getAssetGroup({
			inputDir: '/mock/input/dir',
			outputDir: '/mock/output/dir',
			compilerEntry: {
				files: '**/*.html',
				outputExtension: '.html',
				outputPathField: 'permalink',
				compiler: () => () => '',
			},
		});

		// Only `permalink` is consulted; `path` is left as user metadata.
		expect(result[0]?.outputPath).toBe('/mock/output/dir/custom/landing.html');
	});

	test.each([
		['number', '42'],
		['boolean true', 'true'],
		['boolean false', 'false'],
		['null', 'null'],
		['array', '[/a, /b]'],
		['inline object', '{nested: /x}'],
		['empty string', "''"],
	])('non-string %s value is ignored', async (_label, yamlLiteral) => {
		vol.fromJSON({
			'/mock/input/dir/source.html': `---\npath: ${yamlLiteral}\n---\n<p>X</p>`,
		});

		const result = await getAssetGroup({
			inputDir: '/mock/input/dir',
			outputDir: '/mock/output/dir',
			compilerEntry: {
				files: '**/*.html',
				outputExtension: '.html',
				outputPathField: 'path',
				compiler: () => () => '',
			},
		});

		expect(result[0]?.outputPath).toBe('/mock/output/dir/source.html');
	});

	test('explicit `path: /some/index.html` derives fileSlug from parent dir', async () => {
		vol.fromJSON({
			'/mock/input/dir/source.html': '---\npath: /some/index.html\n---\n<p>X</p>',
		});

		const result = await getAssetGroup({
			inputDir: '/mock/input/dir',
			outputDir: '/mock/output/dir',
			compilerEntry: {
				files: '**/*.html',
				outputExtension: '.html',
				outputPathField: 'path',
				compiler: () => () => '',
			},
		});

		expect(result[0]?.outputPath).toBe('/mock/output/dir/some/index.html');
		expect(result[0]?.url).toBe('/some/');
		expect(result[0]?.filePathStem).toBe('/some/index');
		expect(result[0]?.fileSlug).toBe('some');
	});

	test('throws when two files resolve to the same output path', async () => {
		vol.fromJSON({
			'/mock/input/dir/a.html': '---\npath: /shared.html\n---\n<p>A</p>',
			'/mock/input/dir/b.html': '---\npath: /shared.html\n---\n<p>B</p>',
		});

		await expect(
			getAssetGroup({
				inputDir: '/mock/input/dir',
				outputDir: '/mock/output/dir',
				compilerEntry: {
					files: '**/*.html',
					outputExtension: '.html',
					outputPathField: 'path',
					compiler: () => () => '',
				},
			}),
		).rejects.toThrow(/Output path collision/);
	});

	test('rejects an invalid `path` with a helpful message', async () => {
		vol.fromJSON({
			'/mock/input/dir/source.html': '---\npath: relative/no-slash\n---\n<p>X</p>',
		});

		await expect(
			getAssetGroup({
				inputDir: '/mock/input/dir',
				outputDir: '/mock/output/dir',
				compilerEntry: {
					files: '**/*.html',
					outputExtension: '.html',
					outputPathField: 'path',
					compiler: () => () => '',
				},
			}),
		).rejects.toThrow(/Invalid frontmatter 'path' in/);
	});

	test('rejects path traversal', async () => {
		vol.fromJSON({
			'/mock/input/dir/source.html': '---\npath: /../escape.html\n---\n<p>X</p>',
		});

		await expect(
			getAssetGroup({
				inputDir: '/mock/input/dir',
				outputDir: '/mock/output/dir',
				compilerEntry: {
					files: '**/*.html',
					outputExtension: '.html',
					outputPathField: 'path',
					compiler: () => () => '',
				},
			}),
		).rejects.toThrow(/must not contain/);
	});

	test('JSON sidecar `path` overrides YAML frontmatter `path`', async () => {
		vol.fromJSON({
			'/mock/input/dir/source.html': '---\npath: /from-yaml.html\n---\n<p>X</p>',
			'/mock/input/dir/source.json': JSON.stringify({ path: '/from-json.html' }),
		});

		const result = await getAssetGroup({
			inputDir: '/mock/input/dir',
			outputDir: '/mock/output/dir',
			compilerEntry: {
				files: '**/*.html',
				outputExtension: '.html',
				outputPathField: 'path',
				compiler: () => () => '',
			},
		});

		expect(result[0]?.outputPath).toBe('/mock/output/dir/from-json.html');
	});

	test('JSON sidecar can supply `path` even when YAML has none', async () => {
		vol.fromJSON({
			'/mock/input/dir/source.html': '<p>X</p>',
			'/mock/input/dir/source.json': JSON.stringify({ path: '/from-json.html' }),
		});

		const result = await getAssetGroup({
			inputDir: '/mock/input/dir',
			outputDir: '/mock/output/dir',
			compilerEntry: {
				files: '**/*.html',
				outputExtension: '.html',
				outputPathField: 'path',
				compiler: () => () => '',
			},
		});

		expect(result[0]?.outputPath).toBe('/mock/output/dir/from-json.html');
	});

	test('wraps frontmatter parse errors with the offending file path', async () => {
		vol.fromJSON({
			'/mock/input/dir/source.html': '<p>X</p>',
			'/mock/input/dir/source.json': '{ this is not json',
		});

		await expect(
			getAssetGroup({
				inputDir: '/mock/input/dir',
				outputDir: '/mock/output/dir',
				compilerEntry: {
					files: '**/*.html',
					outputExtension: '.html',
					outputPathField: 'path',
					compiler: () => () => '',
				},
			}),
		).rejects.toThrow(/Failed to read frontmatter from \/mock\/input\/dir\/source\.html/);
	});

	test('honors `path: /` (root index) and exposes empty fileSlug', async () => {
		vol.fromJSON({
			'/mock/input/dir/landing.html': '---\npath: /\n---\n<p>Root</p>',
		});

		const result = await getAssetGroup({
			inputDir: '/mock/input/dir',
			outputDir: '/mock/output/dir',
			compilerEntry: {
				files: '**/*.html',
				outputExtension: '.html',
				outputPathField: 'path',
				compiler: () => () => '',
			},
		});

		expect(result[0]?.outputPath).toBe('/mock/output/dir/index.html');
		expect(result[0]?.url).toBe('/');
		expect(result[0]?.filePathStem).toBe('/index');
		expect(result[0]?.fileSlug).toBe('');
	});
});
