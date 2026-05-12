import type { Transform } from 'kamado/config';
import type { CompilableFile, FileContent, MetaData } from 'kamado/files';

import { minify } from 'html-minifier-terser';
import { mergeConfig } from 'kamado/config';
import { format as prettierFormat } from 'prettier';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createPageCompiler } from './page-compiler.js';

// Both format dependencies are mocked with their real implementation by default.
// Individual tests override the mock per-call to force a failure.
vi.mock('prettier', async (importOriginal) => {
	const actual = await importOriginal<typeof import('prettier')>();
	return {
		...actual,
		format: vi.fn(actual.format),
		resolveConfig: vi.fn(actual.resolveConfig),
	};
});

vi.mock('html-minifier-terser', async (importOriginal) => {
	const actual = await importOriginal<typeof import('html-minifier-terser')>();
	return {
		...actual,
		minify: vi.fn(actual.minify),
	};
});

const mockFileContents = new Map<string, FileContent>();

vi.mock('kamado/files', async (importOriginal) => {
	const original = await importOriginal();
	return {
		...(original as Record<string, unknown>),
		getContentFromFile: vi.fn((file: CompilableFile) => {
			const content = mockFileContents.get(file.inputPath);
			if (!content) {
				throw new Error(`ENOENT: no such file or directory, open '${file.inputPath}'`);
			}
			return Promise.resolve(content);
		}),
		getContentFromFileObject: vi.fn((file: { inputPath: string }) => {
			const content = mockFileContents.get(file.inputPath);
			if (!content) {
				throw new Error(`ENOENT: no such file or directory, open '${file.inputPath}'`);
			}
			return Promise.resolve(content);
		}),
	};
});

const TEST_PAGE: CompilableFile = {
	inputPath: '/path/to/page.html',
	outputPath: '/path/to/page.html',
	fileSlug: 'page',
	filePathStem: '/path/to/page',
	url: '/path/to/page',
	extension: '.html',
	date: new Date(),
};

/**
 *
 * @param message
 */
function forcePrettierFailureOnce(message: string) {
	vi.mocked(prettierFormat).mockImplementationOnce(() =>
		Promise.reject(new SyntaxError(message)),
	);
}

/**
 *
 * @param message
 */
function forceMinifierFailureOnce(message: string) {
	vi.mocked(minify).mockImplementationOnce(() => Promise.reject(new Error(message)));
}

describe('createPageCompiler — formatOptions.parseError (pipeline-level)', async () => {
	const config = await mergeConfig({});
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		mockFileContents.clear();
		mockFileContents.set('/path/to/page.html', {
			metaData: {} as MetaData,
			content: '<p>Hello</p>',
			raw: '<p>Hello</p>',
		});
		warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
	});

	describe('prettier failure', () => {
		test("default 'silent': prettier failure is swallowed, output flows through", async () => {
			forcePrettierFailureOnce('forced prettier failure');
			const pageC = createPageCompiler()({});
			const fn = await pageC.compiler(config);
			const result = await fn(TEST_PAGE, () => '');

			expect(result).toContain('<p>Hello</p>');
			expect(warnSpy).not.toHaveBeenCalled();
		});

		test("'warning': prettier failure logs the full message", async () => {
			forcePrettierFailureOnce('forced prettier failure');
			const pageC = createPageCompiler()({
				formatOptions: { parseError: 'warning' },
			});
			const fn = await pageC.compiler(config);
			const result = await fn(TEST_PAGE, () => '');

			expect(result).toContain('<p>Hello</p>');
			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy.mock.calls[0]?.[0]).toBe(
				"Transform 'prettier' failed on /path/to/page.html: forced prettier failure",
			);
		});

		test("'error': prettier failure throws with transform name and source path", async () => {
			forcePrettierFailureOnce('forced prettier failure');
			const pageC = createPageCompiler()({
				formatOptions: { parseError: 'error' },
			});
			const fn = await pageC.compiler(config);

			await expect(fn(TEST_PAGE, () => '')).rejects.toThrow(
				"Transform 'prettier' failed on /path/to/page.html: forced prettier failure",
			);
		});

		test("'error' preserves the underlying error on cause", async () => {
			forcePrettierFailureOnce('forced prettier failure');
			const pageC = createPageCompiler()({
				formatOptions: { parseError: 'error' },
			});
			const fn = await pageC.compiler(config);

			const err = await fn(TEST_PAGE, () => '').then(
				() => null,
				(error: unknown) => error,
			);

			expect(err).toBeInstanceOf(Error);
			const wrapped = err as Error;
			expect(wrapped.cause).toBeInstanceOf(SyntaxError);
			expect((wrapped.cause as Error).message).toBe('forced prettier failure');
		});
	});

	describe('minifier failure', () => {
		test("default 'silent': minifier failure is swallowed, output flows through", async () => {
			forceMinifierFailureOnce('forced minifier failure');
			const pageC = createPageCompiler()({});
			const fn = await pageC.compiler(config);
			const result = await fn(TEST_PAGE, () => '');

			expect(result).toContain('<p>Hello</p>');
			expect(warnSpy).not.toHaveBeenCalled();
		});

		test("'warning': minifier failure logs the full message", async () => {
			forceMinifierFailureOnce('forced minifier failure');
			const pageC = createPageCompiler()({
				formatOptions: { parseError: 'warning' },
			});
			const fn = await pageC.compiler(config);
			const result = await fn(TEST_PAGE, () => '');

			expect(result).toContain('<p>Hello</p>');
			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy.mock.calls[0]?.[0]).toBe(
				"Transform 'minifier' failed on /path/to/page.html: forced minifier failure",
			);
		});

		test("'error': minifier failure throws with transform name and source path", async () => {
			forceMinifierFailureOnce('forced minifier failure');
			const pageC = createPageCompiler()({
				formatOptions: { parseError: 'error' },
			});
			const fn = await pageC.compiler(config);

			await expect(fn(TEST_PAGE, () => '')).rejects.toThrow(
				"Transform 'minifier' failed on /path/to/page.html: forced minifier failure",
			);
		});
	});

	describe('custom transform failure (verifies "all transforms" scope)', () => {
		const throwingCustomTransform: Transform<MetaData> = {
			name: 'my-broken-transform',
			transform: () => {
				throw new Error('custom transform exploded');
			},
		};

		test("'silent': a failing custom transform is skipped", async () => {
			const pageC = createPageCompiler()({
				transforms: [throwingCustomTransform],
			});
			const fn = await pageC.compiler(config);
			const result = await fn(TEST_PAGE, () => '');

			expect(typeof result).toBe('string');
			expect(warnSpy).not.toHaveBeenCalled();
		});

		test("'error': a failing custom transform throws with its name in the message", async () => {
			const pageC = createPageCompiler()({
				formatOptions: { parseError: 'error' },
				transforms: [throwingCustomTransform],
			});
			const fn = await pageC.compiler(config);

			await expect(fn(TEST_PAGE, () => '')).rejects.toThrow(
				"Transform 'my-broken-transform' failed on /path/to/page.html: custom transform exploded",
			);
		});

		test("'warning': a failing custom transform logs with its name", async () => {
			const pageC = createPageCompiler()({
				formatOptions: { parseError: 'warning' },
				transforms: [throwingCustomTransform],
			});
			const fn = await pageC.compiler(config);
			const result = await fn(TEST_PAGE, () => '');

			expect(typeof result).toBe('string');
			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy.mock.calls[0]?.[0]).toBe(
				"Transform 'my-broken-transform' failed on /path/to/page.html: custom transform exploded",
			);
		});
	});

	describe('pipeline continuation', () => {
		test("'warning': loop continues after a failure — a later transform that also fails logs too", async () => {
			// prettier is the 3rd transform; minifier is the 4th. If the catch broke
			// out of the loop after prettier failed, minifier would never run and warnSpy
			// would be called only once. We assert it is called twice — the loop continues.
			forcePrettierFailureOnce('forced prettier failure');
			forceMinifierFailureOnce('forced minifier failure');
			const pageC = createPageCompiler()({
				formatOptions: { parseError: 'warning' },
			});
			const fn = await pageC.compiler(config);
			await fn(TEST_PAGE, () => '');

			expect(warnSpy).toHaveBeenCalledTimes(2);
			expect(warnSpy.mock.calls[0]?.[0]).toBe(
				"Transform 'prettier' failed on /path/to/page.html: forced prettier failure",
			);
			expect(warnSpy.mock.calls[1]?.[0]).toBe(
				"Transform 'minifier' failed on /path/to/page.html: forced minifier failure",
			);
		});

		test("'silent': the next transform receives the previous step's output", async () => {
			// Verifies that after a silent failure, the pipeline continues AND the
			// downstream transform observes content. Asserted indirectly via the
			// minify mock being invoked even though prettier failed.
			forcePrettierFailureOnce('forced prettier failure');
			const pageC = createPageCompiler()({
				formatOptions: { parseError: 'silent' },
			});
			const fn = await pageC.compiler(config);
			await fn(TEST_PAGE, () => '');

			expect(vi.mocked(minify)).toHaveBeenCalled();
		});
	});

	describe('inputPath -> outputPath fallback', () => {
		test('uses outputPath in the message when inputPath is missing', async () => {
			const fileWithoutInputPath = {
				...TEST_PAGE,
				inputPath: undefined as unknown as string,
				outputPath: '/build/page.html',
			};
			// The kamado/files mock looks up content via file.inputPath; register the
			// undefined key so the lookup succeeds for this scenario.
			mockFileContents.set(undefined as unknown as string, {
				metaData: {} as MetaData,
				content: '<p>Hello</p>',
				raw: '<p>Hello</p>',
			});

			forcePrettierFailureOnce('forced prettier failure');
			const pageC = createPageCompiler()({
				formatOptions: { parseError: 'warning' },
			});
			const fn = await pageC.compiler(config);
			await fn(fileWithoutInputPath, () => '');

			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy.mock.calls[0]?.[0]).toBe(
				"Transform 'prettier' failed on /build/page.html: forced prettier failure",
			);
		});
	});
});
