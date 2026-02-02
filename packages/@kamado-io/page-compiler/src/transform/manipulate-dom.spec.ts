import type { Context, TransformContext } from 'kamado/config';

import { describe, expect, test, vi } from 'vitest';

import { manipulateDOM } from './manipulate-dom.js';

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

describe('manipulateDOM', () => {
	test('should have correct name', () => {
		const transform = manipulateDOM();
		expect(transform.name).toBe('manipulateDOM');
	});

	test('should return content unchanged when no hook and imageSizes is false', async () => {
		const transform = manipulateDOM({ imageSizes: false });
		const info = createMockTransformInfo();
		const content = '<p>test</p>';

		const result = await transform.transform(content, info);

		expect(result).toBe(content);
	});

	test('should apply custom manipulateDOM hook', async () => {
		const customHook = vi.fn((elements, window) => {
			const body = window.document.querySelector('body');
			if (body) {
				const div = window.document.createElement('div');
				div.textContent = 'injected';
				body.append(div);
			}
		});

		const transform = manipulateDOM({ hook: customHook, imageSizes: false });
		const info = createMockTransformInfo();

		const result = await transform.transform('<html><body>test</body></html>', info);

		expect(customHook).toHaveBeenCalled();
		expect(result).toContain('injected');
	});

	test('should receive correct TransformContext in hook', async () => {
		let receivedContext: TransformContext | undefined;

		const transform = manipulateDOM({
			hook: (elements, window, isServe, context) => {
				receivedContext = context;
			},
			imageSizes: false,
		});

		const info = createMockTransformInfo({
			context: {
				mode: 'serve',
				dir: {
					root: '/test/root',
					output: '/test/output',
					input: '/test/input',
					public: '/test/public',
				},
				devServer: {
					host: 'localhost',
					port: 3000,
				},
				pkg: {},
			} as Context,
			inputPath: '/test/input/page.html',
			outputPath: '/test/output/page.html',
		});

		await transform.transform('<html><body>test</body></html>', info);

		expect(receivedContext).toBeDefined();
		expect(receivedContext?.path).toBe('page.html');
		expect(receivedContext?.isServe).toBe(true);
	});

	test('should use custom host option', async () => {
		const transform = manipulateDOM({
			host: 'https://custom.example.com',
			imageSizes: false,
		});
		const info = createMockTransformInfo();

		const result = await transform.transform('<html><body>test</body></html>', info);

		expect(typeof result).toBe('string');
	});
});
