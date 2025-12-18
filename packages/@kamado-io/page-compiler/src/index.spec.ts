import type { PageCompilerOptions } from './index.js';
import type { CompilableFile } from 'kamado/files';

import { mergeConfig } from 'kamado/config';
import { describe, test, expect } from 'vitest';

import { pageCompiler } from './index.js';

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
		expect(result).toBe('<p>Hello, world!</p>\n');
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
		// Pug syntax is not valid HTML, so domSerialize returns empty string
		expect(result).toBe('');
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
		expect(result).toBe('<p>Hello, world!</p>\n');
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
		expect(result).toBe('<p>Hello, world!</p>\n');
	});
});
