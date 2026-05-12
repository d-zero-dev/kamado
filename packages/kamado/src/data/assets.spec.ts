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

	test('"error" throws when two override files resolve to the same output path', async () => {
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
					outputPathConflict: 'error',
					compiler: () => () => '',
				},
			}),
		).rejects.toThrow(/Output path collision/);
	});

	test('"error" message includes a hint on how to switch policies', async () => {
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
					outputPathConflict: 'error',
					compiler: () => () => '',
				},
			}),
		).rejects.toThrow(/outputPathConflict/);
	});

	test('"error" throws on non-override conflicts (same name, different extensions)', async () => {
		vol.fromJSON({
			'/mock/input/dir/page.html': '<p>html</p>',
			'/mock/input/dir/page.pug': 'p pug',
		});

		await expect(
			getAssetGroup({
				inputDir: '/mock/input/dir',
				outputDir: '/mock/output/dir',
				compilerEntry: {
					files: '**/*.{html,pug}',
					outputExtension: '.html',
					outputPathConflict: 'error',
					compiler: () => () => '',
				},
			}),
		).rejects.toThrow(/Output path collision/);
	});

	test('default policy ("warning") between two overrides: first-seen wins, warns once', async () => {
		vol.fromJSON({
			'/mock/input/dir/a.html': '---\npath: /shared.html\n---\n<p>A</p>',
			'/mock/input/dir/b.html': '---\npath: /shared.html\n---\n<p>B</p>',
		});

		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
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
			expect(result[0]?.inputPath).toBe('/mock/input/dir/a.html');
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Output path collision/));
		} finally {
			warn.mockRestore();
		}
	});

	test('"warning" on non-override conflict: first-seen wins, no override required', async () => {
		vol.fromJSON({
			'/mock/input/dir/page.html': '<p>html-version</p>',
			'/mock/input/dir/page.pug': 'p pug-version',
		});

		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const result = await getAssetGroup({
				inputDir: '/mock/input/dir',
				outputDir: '/mock/output/dir',
				compilerEntry: {
					files: '**/*.{html,pug}',
					outputExtension: '.html',
					outputPathConflict: 'warning',
					compiler: () => () => '',
				},
			});

			expect(result).toHaveLength(1);
			expect(result[0]?.inputPath).toBe('/mock/input/dir/page.html');
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});

	test('"silent" suppresses the warning but still drops the loser', async () => {
		vol.fromJSON({
			'/mock/input/dir/a.html': '---\npath: /shared.html\n---\n<p>A</p>',
			'/mock/input/dir/b.html': '---\npath: /shared.html\n---\n<p>B</p>',
		});

		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const result = await getAssetGroup({
				inputDir: '/mock/input/dir',
				outputDir: '/mock/output/dir',
				compilerEntry: {
					files: '**/*.html',
					outputExtension: '.html',
					outputPathField: 'path',
					outputPathConflict: 'silent',
					compiler: () => () => '',
				},
			});

			expect(result).toHaveLength(1);
			expect(result[0]?.inputPath).toBe('/mock/input/dir/a.html');
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	test('override beats default when the default is seen first (override replaces previous)', async () => {
		// memfs preserves insertion order, so `shared.html` (no override) is visited before
		// `with-override.html`. The override file is the second arrival yet must win.
		vol.fromJSON({
			'/mock/input/dir/shared.html': '<p>plain</p>',
			'/mock/input/dir/with-override.html':
				'---\npath: /shared.html\n---\n<p>override</p>',
		});

		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const result = await getAssetGroup({
				inputDir: '/mock/input/dir',
				outputDir: '/mock/output/dir',
				compilerEntry: {
					files: '**/*.html',
					outputExtension: '.html',
					outputPathField: 'path',
					outputPathConflict: 'silent',
					compiler: () => () => '',
				},
			});

			expect(result).toHaveLength(1);
			expect(result[0]?.inputPath).toBe('/mock/input/dir/with-override.html');
			expect(result[0]?.outputPath).toBe('/mock/output/dir/shared.html');
		} finally {
			warn.mockRestore();
		}
	});

	test('override beats default when the override is seen first (default discarded)', async () => {
		// Insert the override file first so it is processed before the default.
		// The default-path file must be discarded, confirming the rule is order-independent.
		vol.fromJSON({
			'/mock/input/dir/with-override.html':
				'---\npath: /shared.html\n---\n<p>override</p>',
			'/mock/input/dir/shared.html': '<p>plain</p>',
		});

		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const result = await getAssetGroup({
				inputDir: '/mock/input/dir',
				outputDir: '/mock/output/dir',
				compilerEntry: {
					files: '**/*.html',
					outputExtension: '.html',
					outputPathField: 'path',
					outputPathConflict: 'silent',
					compiler: () => () => '',
				},
			});

			expect(result).toHaveLength(1);
			expect(result[0]?.inputPath).toBe('/mock/input/dir/with-override.html');
			expect(result[0]?.outputPath).toBe('/mock/output/dir/shared.html');
		} finally {
			warn.mockRestore();
		}
	});

	test('three-way conflict: first override wins, default and second override are dropped', async () => {
		// Processing order (memfs insertion order):
		//   1. collide.html         — default path → stored
		//   2. first-override.html  — override beats default → replaces #1
		//   3. second-override.html — override + first-wins among ties → dropped
		vol.fromJSON({
			'/mock/input/dir/collide.html': '<p>plain default</p>',
			'/mock/input/dir/first-override.html':
				'---\npath: /collide.html\n---\n<p>first override</p>',
			'/mock/input/dir/second-override.html':
				'---\npath: /collide.html\n---\n<p>second override</p>',
		});

		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const result = await getAssetGroup({
				inputDir: '/mock/input/dir',
				outputDir: '/mock/output/dir',
				compilerEntry: {
					files: '**/*.html',
					outputExtension: '.html',
					outputPathField: 'path',
					outputPathConflict: 'silent',
					compiler: () => () => '',
				},
			});

			expect(result).toHaveLength(1);
			expect(result[0]?.inputPath).toBe('/mock/input/dir/first-override.html');
			expect(result[0]?.outputPath).toBe('/mock/output/dir/collide.html');
		} finally {
			warn.mockRestore();
		}
	});

	test('frontmatter parse errors still throw under "silent" policy', async () => {
		// Conflict policy must not swallow parse failures — they are a separate failure mode.
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
					outputPathConflict: 'silent',
					compiler: () => () => '',
				},
			}),
		).rejects.toThrow(/Failed to read frontmatter from \/mock\/input\/dir\/source\.html/);
	});

	test('"warning" emits one warning per collision (N-way conflict)', async () => {
		// 3 override files sharing the same output path → 2 conflicts → 2 warnings.
		vol.fromJSON({
			'/mock/input/dir/a.html': '---\npath: /shared.html\n---\n<p>A</p>',
			'/mock/input/dir/b.html': '---\npath: /shared.html\n---\n<p>B</p>',
			'/mock/input/dir/c.html': '---\npath: /shared.html\n---\n<p>C</p>',
		});

		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const result = await getAssetGroup({
				inputDir: '/mock/input/dir',
				outputDir: '/mock/output/dir',
				compilerEntry: {
					files: '**/*.html',
					outputExtension: '.html',
					outputPathField: 'path',
					outputPathConflict: 'warning',
					compiler: () => () => '',
				},
			});

			expect(result).toHaveLength(1);
			expect(result[0]?.inputPath).toBe('/mock/input/dir/a.html');
			expect(warn).toHaveBeenCalledTimes(2);
		} finally {
			warn.mockRestore();
		}
	});

	test('non-string `path` is treated as fromOverride=false in conflict context', async () => {
		// `with-override.html` has a valid override → fromOverride=true, outputPath=/shared.html.
		// `shared.html` has a non-string `path: 42` → ignored, fromOverride=false, default
		// outputPath=/shared.html. They collide on /shared.html; since only one side carries
		// a real override, the override file must win regardless of glob order.
		vol.fromJSON({
			'/mock/input/dir/with-override.html':
				'---\npath: /shared.html\n---\n<p>override</p>',
			'/mock/input/dir/shared.html': '---\npath: 42\n---\n<p>non-string</p>',
		});

		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const result = await getAssetGroup({
				inputDir: '/mock/input/dir',
				outputDir: '/mock/output/dir',
				compilerEntry: {
					files: '**/*.html',
					outputExtension: '.html',
					outputPathField: 'path',
					outputPathConflict: 'silent',
					compiler: () => () => '',
				},
			});

			expect(result).toHaveLength(1);
			expect(result[0]?.inputPath).toBe('/mock/input/dir/with-override.html');
			expect(result[0]?.outputPath).toBe('/mock/output/dir/shared.html');
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	test('"error" throws on the first collision without processing later files', async () => {
		// File 3 has malformed frontmatter that would throw a parse error if reached.
		// If 'error' policy correctly aborts on the first collision (between files 1 and 2),
		// file 3 is never read and the thrown error references the first pair, not the parse error.
		vol.fromJSON({
			'/mock/input/dir/a.html': '---\npath: /shared.html\n---\n<p>A</p>',
			'/mock/input/dir/b.html': '---\npath: /shared.html\n---\n<p>B</p>',
			'/mock/input/dir/c.html': '<p>C</p>',
			'/mock/input/dir/c.json': '{ this is not json',
		});

		await expect(
			getAssetGroup({
				inputDir: '/mock/input/dir',
				outputDir: '/mock/output/dir',
				compilerEntry: {
					files: '**/*.html',
					outputExtension: '.html',
					outputPathField: 'path',
					outputPathConflict: 'error',
					compiler: () => () => '',
				},
			}),
		).rejects.toThrow(
			/Output path collision.+'\/mock\/input\/dir\/a\.html' and '\/mock\/input\/dir\/b\.html'/,
		);
	});

	test('"silent" emits no console output at all (warn, log, and error are untouched)', async () => {
		vol.fromJSON({
			'/mock/input/dir/a.html': '---\npath: /shared.html\n---\n<p>A</p>',
			'/mock/input/dir/b.html': '---\npath: /shared.html\n---\n<p>B</p>',
		});

		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			await getAssetGroup({
				inputDir: '/mock/input/dir',
				outputDir: '/mock/output/dir',
				compilerEntry: {
					files: '**/*.html',
					outputExtension: '.html',
					outputPathField: 'path',
					outputPathConflict: 'silent',
					compiler: () => () => '',
				},
			});

			expect(warn).not.toHaveBeenCalled();
			expect(log).not.toHaveBeenCalled();
			expect(error).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
			log.mockRestore();
			error.mockRestore();
		}
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
