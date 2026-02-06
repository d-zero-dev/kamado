import type { TransformContext } from 'kamado/config';
import type { MetaData } from 'kamado/files';

import { describe, expect, test } from 'vitest';

import { createDefaultPageTransforms } from './page-transform.js';
import { prettier } from './transform/prettier.js';

const defaultPageTransforms = createDefaultPageTransforms<MetaData>();

/**
 * Creates a mock transform info object for testing
 * @param overrides - Optional overrides for specific fields
 * @returns Mock transform info
 */
function createMockTransformInfo(
	overrides?: Partial<TransformContext<MetaData>>,
): TransformContext<MetaData> {
	const defaultContext: TransformContext<MetaData> = {
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
				open: false,
			},
		},
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

describe('defaultPageTransforms', () => {
	test('should be an array', () => {
		expect(Array.isArray(defaultPageTransforms)).toBe(true);
	});

	test('should contain 5 transforms', () => {
		expect(defaultPageTransforms.length).toBe(5);
	});

	test('should have correct transform names in order', () => {
		const names = defaultPageTransforms.map((t) => t.name);
		expect(names).toEqual([
			'manipulateDOM',
			'doctype',
			'prettier',
			'minifier',
			'lineBreak',
		]);
	});

	test('should allow finding transforms by name', () => {
		const prettier = defaultPageTransforms.find((t) => t.name === 'prettier');
		expect(prettier).toBeDefined();
		expect(prettier?.name).toBe('prettier');
	});

	test('should allow filtering transforms', () => {
		const withoutMinifier = defaultPageTransforms.filter((t) => t.name !== 'minifier');
		expect(withoutMinifier.length).toBe(4);
		expect(withoutMinifier.find((t) => t.name === 'minifier')).toBeUndefined();
	});

	test('should allow mapping transforms', () => {
		const customized = defaultPageTransforms.map((t) =>
			t.name === 'prettier' ? prettier({ options: { printWidth: 120 } }) : t,
		);
		expect(customized.length).toBe(5);
		expect(customized.find((t) => t.name === 'prettier')).toBeDefined();
	});

	test('should execute transforms sequentially', async () => {
		const info = createMockTransformInfo();
		let result: string | ArrayBuffer = '<html><body>test</body></html>';

		// Apply only first 3 transforms
		for (const transform of defaultPageTransforms.slice(0, 3)) {
			result = await transform.transform(result, info);
		}

		expect(typeof result).toBe('string');
	});
});
