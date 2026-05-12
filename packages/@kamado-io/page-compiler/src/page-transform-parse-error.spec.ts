import type { TransformContext } from 'kamado/config';
import type { MetaData } from 'kamado/files';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createDefaultPageTransforms } from './page-transform.js';

// Force prettier.format to always reject so parseError propagation through
// createDefaultPageTransforms can be observed deterministically.
vi.mock('prettier', async (importOriginal) => {
	const actual = await importOriginal<typeof import('prettier')>();
	return {
		...actual,
		format: vi.fn(() => Promise.reject(new SyntaxError('forced test parse error'))),
		resolveConfig: vi.fn(() => Promise.resolve(null)),
	};
});

/**
 *
 * @param overrides
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

	return { ...defaultContext, ...overrides };
}

/**
 *
 * @param parseError
 */
function getPrettierFromDefaults(parseError?: 'silent' | 'warning' | 'error') {
	const transforms = createDefaultPageTransforms<MetaData>(
		parseError === undefined ? undefined : { parseError },
	);
	const prettierTransform = transforms.find((t) => t.name === 'prettier');
	expect(prettierTransform).toBeDefined();
	return prettierTransform!;
}

describe('createDefaultPageTransforms - parseError propagation', () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
	});

	test("default (no option) propagates as 'silent': returns content, no warn", async () => {
		const prettierTransform = getPrettierFromDefaults();
		const result = await prettierTransform.transform('<x>', createMockTransformInfo());
		expect(result).toBe('<x>');
		expect(warnSpy).not.toHaveBeenCalled();
	});

	test("parseError 'silent' propagates: returns content, no warn", async () => {
		const prettierTransform = getPrettierFromDefaults('silent');
		const result = await prettierTransform.transform('<x>', createMockTransformInfo());
		expect(result).toBe('<x>');
		expect(warnSpy).not.toHaveBeenCalled();
	});

	test("parseError 'warning' propagates: console.warn called once with full message", async () => {
		const prettierTransform = getPrettierFromDefaults('warning');
		const result = await prettierTransform.transform('<x>', createMockTransformInfo());
		expect(result).toBe('<x>');
		expect(warnSpy).toHaveBeenCalledTimes(1);
		const calledWith = warnSpy.mock.calls[0]?.[0] as string;
		expect(calledWith).toBe(
			'Prettier failed to format /test/input/page.html: forced test parse error',
		);
	});

	test("parseError 'error' propagates: throw with full wrapped message", async () => {
		const prettierTransform = getPrettierFromDefaults('error');
		await expect(
			prettierTransform.transform('<x>', createMockTransformInfo()),
		).rejects.toThrow(
			'Prettier failed to format /test/input/page.html: forced test parse error',
		);
	});
});
