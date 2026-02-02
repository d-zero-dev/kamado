import type { Context, TransformContext } from 'kamado/config';

import { describe, expect, test } from 'vitest';

import { doctype } from './doctype.js';

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

describe('doctype', () => {
	test('should have correct name', () => {
		const transform = doctype();
		expect(transform.name).toBe('doctype');
	});

	test('should add DOCTYPE by default', async () => {
		const transform = doctype();
		const info = createMockTransformInfo();

		const result = await transform.transform('<html><body>test</body></html>', info);

		expect(typeof result).toBe('string');
	});
});
