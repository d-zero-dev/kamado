import type { CompilableFile, FileContent, MetaData } from 'kamado/files';

import { mergeConfig } from 'kamado/config';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createPageCompiler } from './page-compiler.js';
import { prettier } from './transform/prettier.js';

// Force prettier.format to always reject so the full
//   pageCompiler({ formatOptions }) → createDefaultPageTransforms → prettier
// wire-through can be observed without depending on real parser behavior.
vi.mock('prettier', async (importOriginal) => {
	const actual = await importOriginal<typeof import('prettier')>();
	return {
		...actual,
		format: vi.fn(() => Promise.reject(new SyntaxError('forced test parse error'))),
		resolveConfig: vi.fn(() => Promise.resolve(null)),
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

describe('createPageCompiler - formatOptions.parseError wire-through', async () => {
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

	test('default formatOptions: prettier failure is swallowed silently', async () => {
		const pageC = createPageCompiler()({});
		const fn = await pageC.compiler(config);
		const result = await fn(TEST_PAGE, () => '');
		// Body of the unformatted page reaches the output (manipulateDOM wraps in <html>/<body>)
		expect(typeof result).toBe('string');
		expect(result).toContain('<p>Hello</p>');
		expect(warnSpy).not.toHaveBeenCalled();
	});

	test("formatOptions.parseError = 'silent' is forwarded to the default prettier", async () => {
		const pageC = createPageCompiler()({ formatOptions: { parseError: 'silent' } });
		const fn = await pageC.compiler(config);
		const result = await fn(TEST_PAGE, () => '');
		expect(result).toContain('<p>Hello</p>');
		expect(warnSpy).not.toHaveBeenCalled();
	});

	test("formatOptions.parseError = 'warning' is forwarded: console.warn fires with the full message", async () => {
		const pageC = createPageCompiler()({ formatOptions: { parseError: 'warning' } });
		const fn = await pageC.compiler(config);
		const result = await fn(TEST_PAGE, () => '');
		expect(result).toContain('<p>Hello</p>');
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0]?.[0]).toBe(
			'Prettier failed to format /path/to/page.html: forced test parse error',
		);
	});

	test("formatOptions.parseError = 'error' is forwarded: compilePage throws with the full wrapped message", async () => {
		const pageC = createPageCompiler()({ formatOptions: { parseError: 'error' } });
		const fn = await pageC.compiler(config);
		await expect(fn(TEST_PAGE, () => '')).rejects.toThrow(
			'Prettier failed to format /path/to/page.html: forced test parse error',
		);
	});

	test('formatOptions.parseError is IGNORED when a custom transforms array is supplied', async () => {
		// User supplies their own transforms array → defaults (and their parseError) are dropped.
		// Even though formatOptions.parseError = 'error', the custom prettier with parseError = 'silent'
		// wins, so compilation must NOT throw.
		const pageC = createPageCompiler()({
			formatOptions: { parseError: 'error' },
			transforms: [prettier({ parseError: 'silent' })],
		});
		const fn = await pageC.compiler(config);
		const result = await fn(TEST_PAGE, () => '');
		expect(typeof result).toBe('string');
		expect(warnSpy).not.toHaveBeenCalled();
	});
});
