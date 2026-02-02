import type { Context, TransformContext } from 'kamado/config';

import { describe, expect, test } from 'vitest';

import { characterEntities } from './character-entities.js';

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

describe('characterEntities', () => {
	test('should have correct name', () => {
		const transform = characterEntities();
		expect(transform.name).toBe('characterEntities');
	});

	test('should apply character entities conversion by default', async () => {
		const transform = characterEntities();
		const info = createMockTransformInfo();

		const result = await transform.transform('<p>&nbsp;</p>', info);

		expect(typeof result).toBe('string');
	});
});
