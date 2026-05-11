import type { Context, TransformContext } from 'kamado/config';

import { describe, expect, test } from 'vitest';

import { prettier } from './prettier.js';

/**
 * Creates a mock transform info object for testing
 * @param overrides - Optional overrides for specific fields
 * @returns Mock transform info
 */
function createMockTransformInfo(
	overrides?: Partial<TransformContext>,
): TransformContext {
	const defaultContext: TransformContext = {
		path: 'page.html',
		filePath: 'page.html',
		inputPath: '/test/input/page.html',
		outputPath: '/test/output/page.html',
		outputDir: '/test/output',
		isServe: false,
		context: {
			mode: 'build',
			dir: {
				root: '/test',
				input: '/test/input',
				output: '/test/output',
				public: '/test/public',
			},
			pkg: {
				production: {
					baseURL: 'https://example.com',
				},
			},
			compilers: [],
			devServer: {
				host: 'localhost',
				port: 3000,
			},
		} as Context,
		compile: () => Promise.resolve('<div>mock</div>'),
	};

	const merged = {
		...defaultContext,
		...overrides,
	};

	// Auto-set isServe based on context.mode if not explicitly overridden
	if (overrides?.context && !('isServe' in (overrides || {}))) {
		merged.isServe = merged.context.mode === 'serve';
	}

	return merged;
}

describe('prettier', () => {
	test('should have correct name', () => {
		const transform = prettier();
		expect(transform.name).toBe('prettier');
	});

	test('should format with Prettier by default', async () => {
		const transform = prettier();
		const info = createMockTransformInfo();

		const result = await transform.transform('<html><body>test</body></html>', info);

		expect(typeof result).toBe('string');
	});

	test('should accept custom options', async () => {
		const transform = prettier({
			options: { printWidth: 120 },
		});
		const info = createMockTransformInfo();

		const result = await transform.transform('<html><body>test</body></html>', info);

		expect(typeof result).toBe('string');
	});

	test('should include source file path when Prettier parser fails', async () => {
		const transform = prettier({
			options: { parser: 'json' },
		});
		const info = createMockTransformInfo({
			inputPath: '/test/input/broken.pug',
		});

		await expect(transform.transform('not-valid-json', info)).rejects.toThrow(
			/^Prettier failed to format \/test\/input\/broken\.pug: \S/,
		);
	});

	test('should fall back to outputPath when inputPath is missing', async () => {
		const transform = prettier({
			options: { parser: 'json' },
		});
		const info = createMockTransformInfo({
			inputPath: undefined,
			outputPath: '/test/output/broken.html',
		});

		await expect(transform.transform('not-valid-json', info)).rejects.toThrow(
			/^Prettier failed to format \/test\/output\/broken\.html: \S/,
		);
	});

	test('should preserve the original Prettier error as cause', async () => {
		const transform = prettier({
			options: { parser: 'json' },
		});
		const info = createMockTransformInfo({
			inputPath: '/test/input/broken.pug',
		});

		const error = await transform
			.transform('not-valid-json', info)
			.then(() => null)
			.catch((error_: unknown) => error_);

		expect(error).toBeInstanceOf(Error);
		const wrapped = error as Error;
		expect(wrapped.cause).toBeInstanceOf(Error);
		expect((wrapped.cause as Error).message.length).toBeGreaterThan(0);
		expect(wrapped.message).toContain((wrapped.cause as Error).message);
	});
});
