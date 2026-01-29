import type { Context, ResponseTransform, TransformContext } from '../config/types.js';

import { describe, test, expect, vi } from 'vitest';

import { applyTransforms } from './transform.js';

// Helper function to create a mock context
/**
 *
 * @param mode
 */
function createMockContext(mode: 'serve' | 'build' = 'serve'): Context {
	return {
		mode,
		pkg: { name: 'test', version: '1.0.0' },
		dir: {
			root: '/test',
			input: '/test/src',
			output: '/test/dist',
		},
		devServer: {
			port: 3000,
			host: 'localhost',
			open: false,
			transforms: [],
		},
		compilers: [],
	};
}

// Helper function to create a transform context
/**
 *
 * @param overrides
 */
function createTransformContext(
	overrides: Partial<TransformContext> = {},
): TransformContext {
	return {
		path: '/index.html',
		outputPath: '/test/dist/index.html',
		isServe: true,
		context: createMockContext('serve'),
		...overrides,
	};
}

describe('applyTransforms', () => {
	describe('basic functionality', () => {
		test('returns original content when no transforms provided', async () => {
			const content = '<html>test</html>';
			const context = createTransformContext();
			const result = await applyTransforms(content, context);
			expect(result).toBe(content);
		});

		test('returns original content when transforms array is empty', async () => {
			const content = '<html>test</html>';
			const context = createTransformContext();
			const result = await applyTransforms(content, context, []);
			expect(result).toBe(content);
		});

		test('does not apply transforms in build mode', async () => {
			const content = '<html>test</html>';
			const context = createTransformContext({
				context: createMockContext('build'),
				isServe: false,
			});
			const transform: ResponseTransform = {
				transform: () => 'modified',
			};
			const result = await applyTransforms(content, context, [transform]);
			expect(result).toBe(content);
		});

		test('applies single transform', async () => {
			const content = '<html>test</html>';
			const context = createTransformContext();
			const transform: ResponseTransform = {
				transform: (c) => {
					if (typeof c === 'string') {
						return c.replace('test', 'modified');
					}
					return c;
				},
			};
			const result = await applyTransforms(content, context, [transform]);
			expect(result).toBe('<html>modified</html>');
		});

		test('applies multiple transforms in order', async () => {
			const content = 'original';
			const context = createTransformContext();
			const transforms: ResponseTransform[] = [
				{ transform: (c) => (typeof c === 'string' ? c + '-1' : c) },
				{ transform: (c) => (typeof c === 'string' ? c + '-2' : c) },
				{ transform: (c) => (typeof c === 'string' ? c + '-3' : c) },
			];
			const result = await applyTransforms(content, context, transforms);
			expect(result).toBe('original-1-2-3');
		});

		test('supports async transforms', async () => {
			const content = 'test';
			const context = createTransformContext();
			const transform: ResponseTransform = {
				transform: async (c) => {
					await new Promise((resolve) => setTimeout(resolve, 10));
					return typeof c === 'string' ? c + '-async' : c;
				},
			};
			const result = await applyTransforms(content, context, [transform]);
			expect(result).toBe('test-async');
		});

		test('works with ArrayBuffer content', async () => {
			const buffer = new ArrayBuffer(8);
			const context = createTransformContext();
			const transform: ResponseTransform = {
				transform: (c) => c, // passthrough
			};
			const result = await applyTransforms(buffer, context, [transform]);
			expect(result).toBe(buffer);
		});
	});

	describe('path filtering', () => {
		test('applies transform with matching include pattern', async () => {
			const content = 'test';
			const context = createTransformContext({ path: '/index.html' });
			const transform: ResponseTransform = {
				filter: { include: '**/*.html' },
				transform: (c) => (typeof c === 'string' ? c + '-modified' : c),
			};
			const result = await applyTransforms(content, context, [transform]);
			expect(result).toBe('test-modified');
		});

		test('does not apply transform with non-matching include pattern', async () => {
			const content = 'test';
			const context = createTransformContext({ path: '/index.html' });
			const transform: ResponseTransform = {
				filter: { include: '**/*.css' },
				transform: (c) => (typeof c === 'string' ? c + '-modified' : c),
			};
			const result = await applyTransforms(content, context, [transform]);
			expect(result).toBe('test');
		});

		test('applies transform with multiple include patterns', async () => {
			const content = 'test';
			const context = createTransformContext({ path: '/style.css' });
			const transform: ResponseTransform = {
				filter: { include: ['**/*.html', '**/*.css'] },
				transform: (c) => (typeof c === 'string' ? c + '-modified' : c),
			};
			const result = await applyTransforms(content, context, [transform]);
			expect(result).toBe('test-modified');
		});

		test('does not apply transform with matching exclude pattern', async () => {
			const content = 'test';
			const context = createTransformContext({ path: '/_partial.html' });
			const transform: ResponseTransform = {
				filter: {
					include: '**/*.html',
					exclude: '**/_*.html',
				},
				transform: (c) => (typeof c === 'string' ? c + '-modified' : c),
			};
			const result = await applyTransforms(content, context, [transform]);
			expect(result).toBe('test');
		});

		test('applies transform when not matching exclude pattern', async () => {
			const content = 'test';
			const context = createTransformContext({ path: '/index.html' });
			const transform: ResponseTransform = {
				filter: {
					include: '**/*.html',
					exclude: '**/_*.html',
				},
				transform: (c) => (typeof c === 'string' ? c + '-modified' : c),
			};
			const result = await applyTransforms(content, context, [transform]);
			expect(result).toBe('test-modified');
		});
	});

	describe('error handling', () => {
		test('continues with original content on error', async () => {
			const content = 'test';
			const context = createTransformContext();
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const transform: ResponseTransform = {
				name: 'error-transform',
				transform: () => {
					throw new Error('Transform error');
				},
			};
			const result = await applyTransforms(content, context, [transform]);
			expect(result).toBe('test');
			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining('error-transform'),
				expect.any(Error),
			);
			consoleSpy.mockRestore();
		});

		test('continues with next transform after error', async () => {
			const content = 'test';
			const context = createTransformContext();
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const transforms: ResponseTransform[] = [
				{
					transform: () => {
						throw new Error('First error');
					},
				},
				{
					transform: (c) => (typeof c === 'string' ? c + '-modified' : c),
				},
			];
			const result = await applyTransforms(content, context, transforms);
			expect(result).toBe('test-modified');
			consoleSpy.mockRestore();
		});

		test('uses "anonymous" for transform name when not provided', async () => {
			const content = 'test';
			const context = createTransformContext();
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
			const transform: ResponseTransform = {
				transform: () => {
					throw new Error('Transform error');
				},
			};
			await applyTransforms(content, context, [transform]);
			expect(consoleSpy).toHaveBeenCalledWith(
				expect.stringContaining('anonymous'),
				expect.any(Error),
			);
			consoleSpy.mockRestore();
		});
	});

	describe('real-world scenarios', () => {
		test('injects script tag into HTML', async () => {
			const content = '<html><body></body></html>';
			const context = createTransformContext({ path: '/index.html' });
			const transform: ResponseTransform = {
				name: 'inject-script',
				filter: { include: '**/*.html' },
				transform: (c) => {
					if (typeof c !== 'string') return c;
					return c.replace('</body>', '<script src="/dev.js"></script></body>');
				},
			};
			const result = await applyTransforms(content, context, [transform]);
			expect(result).toBe('<html><body><script src="/dev.js"></script></body></html>');
		});

		test('adds CSS comment header', async () => {
			const content = '.test { color: red; }';
			const context = createTransformContext({
				path: '/style.css',
			});
			const transform: ResponseTransform = {
				name: 'add-header',
				filter: { include: '**/*.css' },
				transform: (c) => {
					if (typeof c !== 'string') return c;
					return `/* Generated */\n${c}`;
				},
			};
			const result = await applyTransforms(content, context, [transform]);
			expect(result).toBe('/* Generated */\n.test { color: red; }');
		});

		test('chains multiple HTML transforms', async () => {
			const content = '<html><head></head><body></body></html>';
			const context = createTransformContext({ path: '/index.html' });
			const transforms: ResponseTransform[] = [
				{
					name: 'inject-meta',
					transform: (c) => {
						if (typeof c !== 'string') return c;
						return c.replace('</head>', '<meta name="test" /></head>');
					},
				},
				{
					name: 'inject-script',
					transform: (c) => {
						if (typeof c !== 'string') return c;
						return c.replace('</body>', '<script></script></body>');
					},
				},
			];
			const result = await applyTransforms(content, context, transforms);
			expect(result).toBe(
				'<html><head><meta name="test" /></head><body><script></script></body></html>',
			);
		});
	});

	describe('path-based filtering', () => {
		test('should apply transform based on path filter alone', async () => {
			const content = 'test content';
			const context = createTransformContext({
				path: '/test.html',
			});

			const transform: ResponseTransform = {
				name: 'html-only',
				filter: {
					include: '**/*.html',
				},
				transform: () => 'transformed',
			};

			const result = await applyTransforms(content, context, [transform]);
			// Should be transformed based on path alone
			expect(result).toBe('transformed');
		});

		test('should apply transform for .shtml files with path filter', async () => {
			const content = 'test content';
			const context = createTransformContext({
				path: '/test.shtml',
			});

			const transform: ResponseTransform = {
				name: 'shtml-transform',
				filter: {
					include: '**/*.shtml',
				},
				transform: () => 'transformed',
			};

			const result = await applyTransforms(content, context, [transform]);
			// Should be transformed based on path
			expect(result).toBe('transformed');
		});

		test('should handle multiple file extensions in filter', async () => {
			const content = 'test content';
			const context = createTransformContext({
				path: '/test.htm',
			});

			const transform: ResponseTransform = {
				name: 'html-like-transform',
				filter: {
					include: ['**/*.html', '**/*.htm', '**/*.shtml'],
				},
				transform: () => 'transformed',
			};

			const result = await applyTransforms(content, context, [transform]);
			expect(result).toBe('transformed');
		});
	});
});
