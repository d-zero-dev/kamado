import type { Context, TransformContext } from 'kamado/config';

import { describe, expect, test } from 'vitest';

import { formatHtml } from './format.js';

describe('formatHtml', () => {
	describe('beforeSerialize hook', () => {
		test('receives TransformContext as third parameter', async () => {
			let receivedContext: TransformContext | undefined;

			const mockContext: Context = {
				mode: 'build',
				dir: {
					root: '/test/root',
					output: '/test/output',
					public: '/test/public',
				},
				devServer: {
					host: 'localhost',
					port: 3000,
				},
				pkg: {},
			} as Context;

			await formatHtml({
				content: '<html><body>test</body></html>',
				inputPath: '/test/input/page.html',
				outputPath: '/test/output/page.html',
				outputDir: '/test/output',
				isServe: false,
				context: mockContext,
				beforeSerialize: (content, isServe, context) => {
					receivedContext = context;
					return content;
				},
			});

			expect(receivedContext).toBeDefined();
			expect(receivedContext?.path).toBe('page.html');
			expect(receivedContext?.inputPath).toBe('/test/input/page.html');
			expect(receivedContext?.outputPath).toBe('/test/output/page.html');
			expect(receivedContext?.isServe).toBe(false);
			expect(receivedContext?.context).toBe(mockContext);
		});

		test('calculates correct path from outputPath', async () => {
			let receivedContext: TransformContext | undefined;

			const mockContext: Context = {
				mode: 'build',
				dir: {
					root: '/test/root',
					output: '/test/output',
					public: '/test/public',
				},
				devServer: {
					host: 'localhost',
					port: 3000,
				},
				pkg: {},
			} as Context;

			await formatHtml({
				content: '<html><body>test</body></html>',
				inputPath: '/test/input/foo/bar/index.html',
				outputPath: '/test/output/foo/bar/index.html',
				outputDir: '/test/output',
				isServe: true,
				context: mockContext,
				beforeSerialize: (content, isServe, context) => {
					receivedContext = context;
					return content;
				},
			});

			expect(receivedContext?.path).toBe('foo/bar/index.html');
			expect(receivedContext?.isServe).toBe(true);
		});

		test('handles root path correctly', async () => {
			let receivedContext: TransformContext | undefined;

			const mockContext: Context = {
				mode: 'build',
				dir: {
					root: '/test/root',
					output: '/test/output',
					public: '/test/public',
				},
				devServer: {
					host: 'localhost',
					port: 3000,
				},
				pkg: {},
			} as Context;

			await formatHtml({
				content: '<html><body>test</body></html>',
				inputPath: '/test/input/index.html',
				outputPath: '/test/output/index.html',
				outputDir: '/test/output',
				isServe: false,
				context: mockContext,
				beforeSerialize: (content, isServe, context) => {
					receivedContext = context;
					return content;
				},
			});

			expect(receivedContext?.path).toBe('index.html');
		});

		test('allows transform utilities to be used in beforeSerialize', async () => {
			const mockContext: Context = {
				mode: 'build',
				dir: {
					root: '/test/root',
					output: '/test/output',
					public: '/test/public',
				},
				devServer: {
					host: 'localhost',
					port: 3000,
				},
				pkg: {},
			} as Context;

			const result = await formatHtml({
				content: '<html><head></head><body>test</body></html>',
				inputPath: '/test/input/page.html',
				outputPath: '/test/output/page.html',
				outputDir: '/test/output',
				isServe: false,
				context: mockContext,
				beforeSerialize: (content, _isServe, context) => {
					// Simulate using a transform utility
					expect(context.path).toBe('page.html');
					expect(context.context.mode).toBe('build');
					return content.replace('</head>', '<script>injected</script></head>');
				},
			});

			expect(result).toContain('<script>injected</script>');
		});
	});
});
