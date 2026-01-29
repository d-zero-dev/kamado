import type { Context, TransformContext } from 'kamado/config';

import { describe, expect, test } from 'vitest';

import { injectToHead } from './inject-to-head.js';

/**
 * Create a mock TransformContext for testing
 * @param overrides
 */
function createMockContext(overrides: Partial<TransformContext> = {}): TransformContext {
	const mockContext: Context = {
		mode: 'serve',
		pkg: {},
		dir: {
			root: '/mock/root',
			input: '/mock/input',
			output: '/mock/output',
		},
		devServer: {
			port: 3000,
			host: 'localhost',
			open: false,
		},
		compilers: [],
	};

	return {
		path: '/test.html',
		outputPath: '/mock/output/test.html',
		isServe: true,
		context: mockContext,
		...overrides,
	};
}

describe('injectToHead', () => {
	describe('basic functionality', () => {
		test('should inject content at head-end by default', async () => {
			const transform = injectToHead({
				content: '<script src="/dev.js"></script>',
			});

			const html = `<!DOCTYPE html>
<html>
<head>
<title>Test</title>
</head>
<body>
<p>Content</p>
</body>
</html>`;

			const result = await transform.transform(html, createMockContext());
			expect(result).toContain('<script src="/dev.js"></script>\n</head>');
		});

		test('should inject content at head-start when specified', async () => {
			const transform = injectToHead({
				content: '<meta name="viewport" content="width=device-width">',
				position: 'head-start',
			});

			const html = `<!DOCTYPE html>
<html>
<head>
<title>Test</title>
</head>
<body>
<p>Content</p>
</body>
</html>`;

			const result = await transform.transform(html, createMockContext());
			expect(result).toContain(
				'<head>\n<meta name="viewport" content="width=device-width">',
			);
		});

		test('should handle ArrayBuffer input', async () => {
			const transform = injectToHead({
				content: '<script src="/dev.js"></script>',
			});

			const html = `<!DOCTYPE html>
<html>
<head>
<title>Test</title>
</head>
<body>
<p>Content</p>
</body>
</html>`;

			const encoder = new TextEncoder();
			const buffer = encoder.encode(html);

			const result = await transform.transform(buffer, createMockContext());
			expect(typeof result).toBe('string');
			expect(result).toContain('<script src="/dev.js"></script>');
		});
	});

	describe('dynamic content', () => {
		test('should support function for dynamic content', async () => {
			const transform = injectToHead({
				content: () => '<meta name="timestamp" content="123456">',
			});

			const html = `<!DOCTYPE html>
<html>
<head>
<title>Test</title>
</head>
<body>
<p>Content</p>
</body>
</html>`;

			const result = await transform.transform(html, createMockContext());
			expect(result).toContain('<meta name="timestamp" content="123456">');
		});

		test('should support async function for dynamic content', async () => {
			const transform = injectToHead({
				content: async () => {
					await new Promise((resolve) => setTimeout(resolve, 10));
					return '<meta name="async" content="true">';
				},
			});

			const html = `<!DOCTYPE html>
<html>
<head>
<title>Test</title>
</head>
<body>
<p>Content</p>
</body>
</html>`;

			const result = await transform.transform(html, createMockContext());
			expect(result).toContain('<meta name="async" content="true">');
		});
	});

	describe('filter configuration', () => {
		test('should have default filter for HTML files', () => {
			const transform = injectToHead({
				content: '<script src="/dev.js"></script>',
			});

			expect(transform.filter).toBeDefined();
			expect(transform.filter?.include).toBe('**/*.html');
		});

		test('should allow custom filter configuration', () => {
			const transform = injectToHead({
				content: '<script src="/dev.js"></script>',
				filter: {
					include: '**/*.htm',
					exclude: '**/admin/**',
				},
			});

			expect(transform.filter?.include).toBe('**/*.htm');
			expect(transform.filter?.exclude).toBe('**/admin/**');
		});

		test('should allow custom name', () => {
			const transform = injectToHead({
				content: '<script src="/dev.js"></script>',
				name: 'custom-inject',
			});

			expect(transform.name).toBe('custom-inject');
		});
	});

	describe('edge cases', () => {
		test('should handle head tag with attributes', async () => {
			const transform = injectToHead({
				content: '<script src="/dev.js"></script>',
			});

			const html = `<!DOCTYPE html>
<html>
<head lang="en">
<title>Test</title>
</head>
<body>
<p>Content</p>
</body>
</html>`;

			const result = await transform.transform(html, createMockContext());
			expect(result).toContain('<script src="/dev.js"></script>\n</head>');
		});

		test('should handle multiple injections', async () => {
			const transform1 = injectToHead({
				content: '<script src="/first.js"></script>',
			});
			const transform2 = injectToHead({
				content: '<script src="/second.js"></script>',
			});

			const html = `<!DOCTYPE html>
<html>
<head>
<title>Test</title>
</head>
<body>
<p>Content</p>
</body>
</html>`;

			const result1 = await transform1.transform(html, createMockContext());
			const result2 = await transform2.transform(result1, createMockContext());

			expect(result2).toContain('<script src="/first.js"></script>');
			expect(result2).toContain('<script src="/second.js"></script>');
		});
	});
});
