import type { PageCompilerOptions } from './page.js';
import type { CompilableFile } from '../files/types.js';

import { describe, test, expect } from 'vitest';

import { mergeConfig } from '../config/merge.js';

import { pageCompiler } from './page.js';

describe('page compiler', async () => {
	const config = await mergeConfig({});

	/**
	 *
	 * @param page
	 * @param options
	 */
	async function compilePage(page: CompilableFile, options: PageCompilerOptions) {
		const pageC = pageCompiler(options);
		const fn = await pageC(config);
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
			outputFileType: 'page',
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

	test('should compile a page made with pug', async () => {
		const content = 'p Hello, world!';
		const page: CompilableFile = {
			inputPath: '/path/to/page.pug',
			outputPath: '/path/to/page.html',
			fileSlug: 'page',
			filePathStem: '/path/to/page',
			url: '/path/to/page',
			extension: '.pug',
			outputFileType: 'page',
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

	test('should compile a page made with pug with layout', async () => {
		const page: CompilableFile = {
			inputPath: '/path/to/page.pug',
			outputPath: '/path/to/page.html',
			fileSlug: 'page',
			filePathStem: '/path/to/page',
			url: '/path/to/page',
			extension: '.pug',
			outputFileType: 'page',
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
});
