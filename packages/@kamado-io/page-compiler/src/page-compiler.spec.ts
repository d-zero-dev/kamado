import type { BreadcrumbItem } from './features/breadcrumbs.js';
import type { NavNode } from './features/nav.js';
import type { Transform } from './page-compiler.js';
import type { PageCompilerOptions } from './types.js';
import type { CompilableFile } from 'kamado/files';

import { mergeConfig } from 'kamado/config';
import { describe, test, expect, expectTypeOf } from 'vitest';

import { pageCompiler } from './page-compiler.js';
import { defaultPageTransforms } from './page-transform.js';
import { manipulateDOM } from './transform/manipulate-dom.js';

describe('page compiler', async () => {
	const config = await mergeConfig({});

	/**
	 *
	 * @param page
	 * @param options
	 */
	async function compilePage(page: CompilableFile, options: PageCompilerOptions) {
		const pageC = pageCompiler(options);
		const fn = await pageC.compiler(config);
		return fn(page, () => '');
	}

	test('should compile a page', async () => {
		const content = '<p>Hello, world!</p>';
		const page: CompilableFile = {
			inputPath: '/path/to/page.html',
			outputPath: '/path/to/page.html',
			fileSlug: 'page',
			filePathStem: '/path/to/page',
			url: '/path/to/page',
			extension: '.html',
			date: new Date(),
			get: () =>
				Promise.resolve({
					metaData: {},
					content,
					raw: content,
				}),
		};
		const result = await compilePage(page, {});
		// With default transforms, includes DOCTYPE, HTML structure, and formatting
		expect(result).toContain('<p>Hello, world!</p>');
		expect(result).toContain('<!DOCTYPE html>');
	});

	test('should pass through pug file without compiler', async () => {
		const content = 'p Hello, world!';
		const page: CompilableFile = {
			inputPath: '/path/to/page.pug',
			outputPath: '/path/to/page.html',
			fileSlug: 'page',
			filePathStem: '/path/to/page',
			url: '/path/to/page',
			extension: '.pug',
			date: new Date(),
			get: () =>
				Promise.resolve({
					metaData: {},
					content,
					raw: content,
				}),
		};
		const result = await compilePage(page, {});
		// Pug syntax is treated as text by JSDOM, so it gets wrapped in HTML structure
		expect(result).toContain('p Hello, world!');
	});

	test('should compile a page made with pug using compileHooks', async () => {
		const { compilePug } = await import('@kamado-io/pug-compiler');
		const content = 'p Hello, world!';
		const page: CompilableFile = {
			inputPath: '/path/to/page.pug',
			outputPath: '/path/to/page.html',
			fileSlug: 'page',
			filePathStem: '/path/to/page',
			url: '/path/to/page',
			extension: '.pug',
			date: new Date(),
			get: () =>
				Promise.resolve({
					metaData: {},
					content,
					raw: content,
				}),
		};
		const compiler = compilePug({
			doctype: 'html',
			pretty: true,
		});
		const result = await compilePage(page, {
			compileHooks: {
				main: {
					compiler,
				},
			},
		});
		// With default transforms, includes DOCTYPE and HTML structure
		expect(result).toContain('<p>Hello, world!</p>');
		expect(result).toContain('<!DOCTYPE html>');
	});

	test('should compile a page made with pug with layout using compileHooks', async () => {
		const { compilePug } = await import('@kamado-io/pug-compiler');
		const compiler = compilePug({
			doctype: 'html',
			pretty: true,
		});
		const page: CompilableFile = {
			inputPath: '/path/to/page.pug',
			outputPath: '/path/to/page.html',
			fileSlug: 'page',
			filePathStem: '/path/to/page',
			url: '/path/to/page',
			extension: '.pug',
			date: new Date(),
			get: () =>
				Promise.resolve({
					metaData: {
						layout: 'layout.pug',
					},
					content: 'p Hello, world!',
					raw: '__DUMMY__',
				}),
		};
		const result = await compilePage(page, {
			layouts: {
				files: {
					'layout.pug': {
						inputPath: '/path/to/layout.pug',
						get: () =>
							Promise.resolve({
								metaData: {},
								content: 'html\n  body\n    main !{content}',
								raw: '__DUMMY__',
							}),
					},
				},
			},
			compileHooks: {
				main: {
					compiler,
				},
				layout: {
					compiler,
				},
			},
		});
		expect(result).toBe(`<!DOCTYPE html>
<html>
  <head></head>
  <body>
    <main>
      <p>Hello, world!</p>
    </main>
  </body>
</html>
`);
	});

	test('should use createCompileHooks helper', async () => {
		const { createCompileHooks } = await import('@kamado-io/pug-compiler');
		const content = 'p Hello, world!';
		const page: CompilableFile = {
			inputPath: '/path/to/page.pug',
			outputPath: '/path/to/page.html',
			fileSlug: 'page',
			filePathStem: '/path/to/page',
			url: '/path/to/page',
			extension: '.pug',
			date: new Date(),
			get: () =>
				Promise.resolve({
					metaData: {},
					content,
					raw: content,
				}),
		};
		const result = await compilePage(page, {
			compileHooks: createCompileHooks({
				doctype: 'html',
				pretty: true,
			}),
		});
		// With default transforms, includes DOCTYPE and HTML structure
		expect(result).toContain('<p>Hello, world!</p>');
		expect(result).toContain('<!DOCTYPE html>');
	});
});

describe('type inference for transform options', () => {
	describe('PageCompilerOptions transform functions', () => {
		test('transformBreadcrumbItem should accept valid function', () => {
			const options: PageCompilerOptions = {
				transformBreadcrumbItem: (item) => ({
					...item,
					icon: 'test',
				}),
			};

			expectTypeOf(options.transformBreadcrumbItem).toExtend<
				((item: BreadcrumbItem) => BreadcrumbItem) | undefined
			>();
		});

		test('transformNavNode should accept valid function', () => {
			const options: PageCompilerOptions = {
				transformNavNode: (node) => ({
					...node,
					badge: 'test',
				}),
			};

			expectTypeOf(options.transformNavNode).toExtend<
				((node: NavNode) => NavNode | null | undefined) | undefined
			>();
		});

		test('transformBreadcrumbItem should accept sync function', () => {
			const options: PageCompilerOptions = {
				transformBreadcrumbItem: (item) => {
					return {
						...item,
					};
				},
			};

			expect(options.transformBreadcrumbItem).toBeDefined();
		});

		test('transformNavNode should accept sync function', () => {
			const options: PageCompilerOptions = {
				transformNavNode: (node) => {
					return {
						...node,
					};
				},
			};

			expect(options.transformNavNode).toBeDefined();
		});
	});
});

describe('pageCompiler with custom transforms', async () => {
	const config = await mergeConfig({});

	/**
	 *
	 * @param page
	 * @param options
	 */
	async function compilePage(page: CompilableFile, options: PageCompilerOptions) {
		const pageC = pageCompiler(options);
		const fn = await pageC.compiler(config);
		return fn(page, () => '');
	}

	test('uses custom transforms instead of default', async () => {
		const customTransform: Transform = {
			name: 'custom',
			transform: (content) => {
				const str =
					typeof content === 'string' ? content : new TextDecoder().decode(content);
				return `<!-- CUSTOM -->${str}`;
			},
		};

		const content = '<p>Hello, world!</p>';
		const page: CompilableFile = {
			inputPath: '/path/to/page.html',
			outputPath: '/path/to/page.html',
			fileSlug: 'page',
			filePathStem: '/path/to/page',
			url: '/path/to/page',
			extension: '.html',
			date: new Date(),
			get: () =>
				Promise.resolve({
					metaData: {},
					content,
					raw: content,
				}),
		};

		const result = await compilePage(page, {
			transforms: [customTransform],
		});

		expect(result).toContain('<!-- CUSTOM -->');
		expect(result).toContain('<p>Hello, world!</p>');
	});

	test('uses defaultPageTransforms when no transforms provided', async () => {
		const content = '<p>Hello, world!</p>';
		const page: CompilableFile = {
			inputPath: '/path/to/page.html',
			outputPath: '/path/to/page.html',
			fileSlug: 'page',
			filePathStem: '/path/to/page',
			url: '/path/to/page',
			extension: '.html',
			date: new Date(),
			get: () =>
				Promise.resolve({
					metaData: {},
					content,
					raw: content,
				}),
		};

		const result = await compilePage(page, {});

		expect(result).toContain('<p>Hello, world!</p>');
	});

	test('transform receives correct info', async () => {
		let receivedInfo: unknown;
		const customTransform: Transform = {
			name: 'custom',
			transform: (content, info) => {
				receivedInfo = info;
				return content;
			},
		};

		const content = '<p>Test content</p>';
		const page: CompilableFile = {
			inputPath: '/input/path/page.html',
			outputPath: '/output/path/page.html',
			fileSlug: 'page',
			filePathStem: '/path/to/page',
			url: '/path/to/page',
			extension: '.html',
			date: new Date(),
			get: () =>
				Promise.resolve({
					metaData: {},
					content,
					raw: content,
				}),
		};

		await compilePage(page, {
			transforms: [customTransform],
		});

		expect(receivedInfo).toBeDefined();
		expect(receivedInfo.inputPath).toBe('/input/path/page.html');
		expect(receivedInfo.outputPath).toBe('/output/path/page.html');
		expect(receivedInfo.context).toBeDefined();
		expect(receivedInfo.compile).toBeDefined();
	});

	test('can use transform factories with custom options', async () => {
		const content = '<p>Hello, world!</p>';
		const page: CompilableFile = {
			inputPath: '/path/to/page.html',
			outputPath: '/path/to/page.html',
			fileSlug: 'page',
			filePathStem: '/path/to/page',
			url: '/path/to/page',
			extension: '.html',
			date: new Date(),
			get: () =>
				Promise.resolve({
					metaData: {},
					content,
					raw: content,
				}),
		};

		const result = await compilePage(page, {
			transforms: [
				{
					name: 'custom-replace',
					transform: (content) => {
						if (typeof content !== 'string') {
							const decoder = new TextDecoder('utf-8');
							content = decoder.decode(content);
						}
						return content.replace('Hello', 'Goodbye');
					},
				},
				manipulateDOM({ imageSizes: false }),
			],
		});

		expect(result).toContain('Goodbye, world!');
		expect(result).not.toContain('Hello, world!');
	});

	test('can extend defaultPageTransforms', async () => {
		const customTransform: Transform = {
			name: 'custom-postprocess',
			transform: (content) => {
				const str =
					typeof content === 'string' ? content : new TextDecoder().decode(content);
				return str.replace('world', 'universe');
			},
		};

		const content = '<p>Hello, world!</p>';
		const page: CompilableFile = {
			inputPath: '/path/to/page.html',
			outputPath: '/path/to/page.html',
			fileSlug: 'page',
			filePathStem: '/path/to/page',
			url: '/path/to/page',
			extension: '.html',
			date: new Date(),
			get: () =>
				Promise.resolve({
					metaData: {},
					content,
					raw: content,
				}),
		};

		const result = await compilePage(page, {
			transforms: [...defaultPageTransforms, customTransform],
		});

		expect(result).toContain('universe');
		expect(result).not.toContain('world');
	});

	test('can use function to extend defaultPageTransforms', async () => {
		const customTransform: Transform = {
			name: 'custom-postprocess',
			transform: (content) => {
				const str =
					typeof content === 'string' ? content : new TextDecoder().decode(content);
				return str.replace('world', 'universe');
			},
		};

		const content = '<p>Hello, world!</p>';
		const page: CompilableFile = {
			inputPath: '/path/to/page.html',
			outputPath: '/path/to/page.html',
			fileSlug: 'page',
			filePathStem: '/path/to/page',
			url: '/path/to/page',
			extension: '.html',
			date: new Date(),
			get: () =>
				Promise.resolve({
					metaData: {},
					content,
					raw: content,
				}),
		};

		const result = await compilePage(page, {
			// Use function to extend defaults (no import needed)
			transforms: (defaults) => [...defaults, customTransform],
		});

		expect(result).toContain('universe');
		expect(result).not.toContain('world');
	});

	test('can filter transforms from defaults', async () => {
		const content = '<p>Hello, world!</p>';
		const page: CompilableFile = {
			inputPath: '/path/to/page.html',
			outputPath: '/path/to/page.html',
			fileSlug: 'page',
			filePathStem: '/path/to/page',
			url: '/path/to/page',
			extension: '.html',
			date: new Date(),
			get: () =>
				Promise.resolve({
					metaData: {},
					content,
					raw: content,
				}),
		};

		// Remove prettier and minifier
		const result = await compilePage(page, {
			transforms: defaultPageTransforms.filter(
				(t) => t.name !== 'prettier' && t.name !== 'minifier',
			),
		});

		expect(result).toContain('Hello, world!');
	});
});
