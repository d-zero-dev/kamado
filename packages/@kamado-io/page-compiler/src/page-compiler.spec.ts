import type { BreadcrumbItem } from './features/breadcrumbs.js';
import type { NavNode } from './features/nav.js';
import type { Transform } from './page-compiler.js';
import type { PageCompilerOptions } from './types.js';
import type { CompilableFile, FileContent } from 'kamado/files';

import { mergeConfig } from 'kamado/config';
import { describe, test, expect, expectTypeOf, vi } from 'vitest';

import { pageCompiler } from './page-compiler.js';
import { defaultPageTransforms } from './page-transform.js';
import { manipulateDOM } from './transform/manipulate-dom.js';

// Mock file content storage for tests
const mockFileContents = new Map<string, FileContent>();

vi.mock('kamado/files', async (importOriginal) => {
	const original = await importOriginal();
	return {
		...original,
		getContentFromFile: vi.fn((file: CompilableFile) => {
			const content = mockFileContents.get(file.inputPath);
			if (!content) {
				throw new Error(`ENOENT: no such file or directory, open '${file.inputPath}'`);
			}
			return Promise.resolve(content);
		}),
		getContentFromFileObject: vi.fn((file: { inputPath: string }) => {
			const content = mockFileContents.get(file.inputPath);
			if (!content) {
				throw new Error(`ENOENT: no such file or directory, open '${file.inputPath}'`);
			}
			return Promise.resolve(content);
		}),
	};
});

/**
 * Helper to set mock file content for tests
 * @param inputPath
 * @param content
 */
function setMockFileContent(inputPath: string, content: FileContent) {
	mockFileContents.set(inputPath, content);
}

/**
 * Helper to clear mock file contents
 */
function clearMockFileContents() {
	mockFileContents.clear();
}

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
		clearMockFileContents();
		const content = '<p>Hello, world!</p>';
		const page: CompilableFile = {
			inputPath: '/path/to/page.html',
			outputPath: '/path/to/page.html',
			fileSlug: 'page',
			filePathStem: '/path/to/page',
			url: '/path/to/page',
			extension: '.html',
			date: new Date(),
		};
		setMockFileContent('/path/to/page.html', {
			metaData: {},
			content,
			raw: content,
		});
		const result = await compilePage(page, {});
		expect(result).toBe('<p>Hello, world!</p>\n');
	});

	test('should pass through pug file without compiler', async () => {
		clearMockFileContents();
		const content = 'p Hello, world!';
		const page: CompilableFile = {
			inputPath: '/path/to/page.pug',
			outputPath: '/path/to/page.html',
			fileSlug: 'page',
			filePathStem: '/path/to/page',
			url: '/path/to/page',
			extension: '.pug',
			date: new Date(),
		};
		setMockFileContent('/path/to/page.pug', {
			metaData: {},
			content,
			raw: content,
		});
		const result = await compilePage(page, {});
		// Pug syntax is not valid HTML, so domSerialize returns empty string
		expect(result).toBe('');
	});

	test('should compile a page made with pug using compileHooks', async () => {
		clearMockFileContents();
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
		};
		setMockFileContent('/path/to/page.pug', {
			metaData: {},
			content,
			raw: content,
		});
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
		expect(result).toBe('<p>Hello, world!</p>\n');
	});

	test('should compile a page made with pug with layout using compileHooks', async () => {
		clearMockFileContents();
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
		};
		setMockFileContent('/path/to/page.pug', {
			metaData: {
				layout: 'layout.pug',
			},
			content: 'p Hello, world!',
			raw: '__DUMMY__',
		});
		setMockFileContent('/path/to/layout.pug', {
			metaData: {},
			content: 'html\n  body\n    main !{content}',
			raw: '__DUMMY__',
		});
		const result = await compilePage(page, {
			layouts: {
				files: {
					'layout.pug': {
						inputPath: '/path/to/layout.pug',
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
		clearMockFileContents();
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
		};
		setMockFileContent('/path/to/page.pug', {
			metaData: {},
			content,
			raw: content,
		});
		const result = await compilePage(page, {
			compileHooks: createCompileHooks({
				doctype: 'html',
				pretty: true,
			}),
		});
		expect(result).toBe('<p>Hello, world!</p>\n');
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
				filter: (node) => ({
					...node,
					badge: 'test',
				}),
			};

			expectTypeOf(options.filter).toExtend<
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
				filter: (node) => {
					return {
						...node,
					};
				},
			};

			expect(options.filter).toBeDefined();
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
		clearMockFileContents();
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
		};
		setMockFileContent('/path/to/page.html', {
			metaData: {},
			content,
			raw: content,
		});

		const result = await compilePage(page, {
			transforms: [customTransform],
		});

		expect(result).toContain('<!-- CUSTOM -->');
		expect(result).toContain('<p>Hello, world!</p>');
	});

	test('uses defaultPageTransforms when no transforms provided', async () => {
		clearMockFileContents();
		const content = '<p>Hello, world!</p>';
		const page: CompilableFile = {
			inputPath: '/path/to/page.html',
			outputPath: '/path/to/page.html',
			fileSlug: 'page',
			filePathStem: '/path/to/page',
			url: '/path/to/page',
			extension: '.html',
			date: new Date(),
		};
		setMockFileContent('/path/to/page.html', {
			metaData: {},
			content,
			raw: content,
		});

		const result = await compilePage(page, {});

		expect(result).toContain('<p>Hello, world!</p>');
	});

	test('transform receives correct info', async () => {
		clearMockFileContents();
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
		};
		setMockFileContent('/input/path/page.html', {
			metaData: {},
			content,
			raw: content,
		});

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
		clearMockFileContents();
		const content = '<p>Hello, world!</p>';
		const page: CompilableFile = {
			inputPath: '/path/to/page.html',
			outputPath: '/path/to/page.html',
			fileSlug: 'page',
			filePathStem: '/path/to/page',
			url: '/path/to/page',
			extension: '.html',
			date: new Date(),
		};
		setMockFileContent('/path/to/page.html', {
			metaData: {},
			content,
			raw: content,
		});

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
		clearMockFileContents();
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
		};
		setMockFileContent('/path/to/page.html', {
			metaData: {},
			content,
			raw: content,
		});

		const result = await compilePage(page, {
			transforms: [...defaultPageTransforms, customTransform],
		});

		expect(result).toContain('universe');
		expect(result).not.toContain('world');
	});

	test('can use function to extend defaultPageTransforms', async () => {
		clearMockFileContents();
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
		};
		setMockFileContent('/path/to/page.html', {
			metaData: {},
			content,
			raw: content,
		});

		const result = await compilePage(page, {
			// Use function to extend defaults (no import needed)
			transforms: (defaults) => [...defaults, customTransform],
		});

		expect(result).toContain('universe');
		expect(result).not.toContain('world');
	});

	test('can filter transforms from defaults', async () => {
		clearMockFileContents();
		const content = '<p>Hello, world!</p>';
		const page: CompilableFile = {
			inputPath: '/path/to/page.html',
			outputPath: '/path/to/page.html',
			fileSlug: 'page',
			filePathStem: '/path/to/page',
			url: '/path/to/page',
			extension: '.html',
			date: new Date(),
		};
		setMockFileContent('/path/to/page.html', {
			metaData: {},
			content,
			raw: content,
		});

		// Remove prettier and minifier
		const result = await compilePage(page, {
			transforms: defaultPageTransforms.filter(
				(t) => t.name !== 'prettier' && t.name !== 'minifier',
			),
		});

		expect(result).toContain('Hello, world!');
	});
});
