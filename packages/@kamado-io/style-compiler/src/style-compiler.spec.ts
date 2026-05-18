import type { Context } from 'kamado/config';
import type * as KamadoFiles from 'kamado/files';
import type { CompilableFile, FileContent, MetaData } from 'kamado/files';

import { describe, expect, test, vi } from 'vitest';

import { createStyleCompiler } from './style-compiler.js';

const mockFileContents = new Map<string, FileContent>();

vi.mock('kamado/files', async (importOriginal) => {
	const original = await importOriginal<typeof KamadoFiles>();
	return {
		...original,
		getContentFromFile: vi.fn((file: CompilableFile) => {
			const content = mockFileContents.get(file.inputPath);
			if (!content) {
				throw new Error(`ENOENT: no such file or directory, open '${file.inputPath}'`);
			}
			return Promise.resolve(content);
		}),
	};
});

/**
 *
 * @param inputPath
 * @param css
 */
function setMockFile(inputPath: string, css: string) {
	mockFileContents.set(inputPath, { content: css, raw: css });
}

/**
 *
 * @param mode
 */
function makeContext(mode: 'serve' | 'build'): Context<MetaData> {
	return {
		mode,
		pkg: { name: 'test', version: '1.0.0' },
		dir: { root: '/test', input: '/test/src', output: '/test/dist' },
		devServer: { port: 3000, host: 'localhost', open: false, transforms: [] },
		compilers: () => [],
	} as Context<MetaData>;
}

/**
 *
 * @param inputPath
 */
function makeFile(inputPath = '/test/src/style.css'): CompilableFile {
	return {
		inputPath,
		outputPath: '/test/dist/style.css',
		fileSlug: 'style',
		filePathStem: '/test/src/style',
		url: '/style.css',
		extension: '.css',
		date: new Date(),
	};
}

const SOURCE_MAP_RE = /\/\*#\s*sourceMappingURL=data:application\/json;base64,/;

/**
 *
 * @param mode
 * @param options
 * @param css
 */
async function compile(
	mode: 'serve' | 'build',
	options: Parameters<ReturnType<typeof createStyleCompiler<MetaData>>>[0],
	css = '.a{color:red}',
) {
	mockFileContents.clear();
	const file = makeFile();
	setMockFile(file.inputPath, css);
	const entry = createStyleCompiler<MetaData>()(options);
	const fn = await entry.compiler(makeContext(mode));
	const out = await fn(file, () => Promise.resolve(''), undefined, false);
	return typeof out === 'string' ? out : new TextDecoder().decode(out);
}

describe('createStyleCompiler / sourcemap', () => {
	test('omits source map by default', async () => {
		const out = await compile('build', {});
		expect(out).not.toMatch(SOURCE_MAP_RE);
	});

	test('emits inline source map when sourcemap is true', async () => {
		const out = await compile('build', { sourcemap: true });
		expect(out).toMatch(SOURCE_MAP_RE);
	});

	test('omits source map when sourcemap is false', async () => {
		const out = await compile('build', { sourcemap: false });
		expect(out).not.toMatch(SOURCE_MAP_RE);
	});

	test("emits source map when sourcemap is 'onServer' and mode is serve", async () => {
		const out = await compile('serve', { sourcemap: 'onServer' });
		expect(out).toMatch(SOURCE_MAP_RE);
	});

	test("omits source map when sourcemap is 'onServer' and mode is build", async () => {
		const out = await compile('build', { sourcemap: 'onServer' });
		expect(out).not.toMatch(SOURCE_MAP_RE);
	});
});

describe('createStyleCompiler / banner parity', () => {
	test('banner text is preserved through cssnano regardless of sourcemap flag', async () => {
		const banner = 'rev. 2026-05-15\ncopyright marker';
		const off = await compile('build', { banner });
		const on = await compile('serve', { sourcemap: 'onServer', banner });
		expect(off).toContain('rev. 2026-05-15');
		expect(off).toContain('copyright marker');
		expect(on).toContain('rev. 2026-05-15');
		expect(on).toContain('copyright marker');
	});

	test('banner survives minification (preserved as /*! comment)', async () => {
		const banner = '/*\nkeep me\n*/';
		const out = await compile('build', { banner });
		expect(out).toContain('keep me');
		expect(out).toContain('/*!');
	});

	test('plain string banner is wrapped in a /*! comment safely', async () => {
		const out = await compile('build', { banner: 'plain text marker' });
		expect(out).toContain('plain text marker');
		expect(out).toContain('/*!');
	});
});
