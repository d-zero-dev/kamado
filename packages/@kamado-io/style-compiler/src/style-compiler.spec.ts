import type { StyleCompilerOptions } from './style-compiler.js';
import type { Context } from 'kamado/config';
import type * as KamadoFiles from 'kamado/files';
import type { CompilableFile, FileContent, MetaData } from 'kamado/files';

// eslint-disable-next-line import-x/default
import postcssLoadConfig from 'postcss-load-config';
import { describe, test, expect, vi, beforeEach } from 'vitest';

import { createStyleCompiler } from './style-compiler.js';

// Mock file content storage for tests
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

vi.mock('postcss-load-config', () => ({
	default: vi.fn(),
}));

const mockedLoadConfig = vi.mocked(postcssLoadConfig);

// Reset shared state and give the config loader a valid default for every
// test. Individual tests override with mockResolvedValueOnce/mockRejectedValueOnce.
beforeEach(() => {
	mockFileContents.clear();
	mockedLoadConfig.mockReset();
	// @ts-ignore -- minimal config shape for tests
	mockedLoadConfig.mockResolvedValue({ plugins: [] });
});

/**
 * Registers mock CSS content for a source path
 * @param inputPath
 * @param css
 */
function setMockFile(inputPath: string, css: string) {
	mockFileContents.set(inputPath, { content: css, raw: css });
}

/**
 * Creates a minimal execution context for the given mode
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
 * Creates a minimal CompilableFile for tests
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

/**
 * Creates the innermost compile function for the given mode
 * @param options
 * @param mode
 */
async function createCompileFn(
	options?: StyleCompilerOptions,
	mode: 'serve' | 'build' = 'build',
) {
	const entry = createStyleCompiler<MetaData>()(options);
	return await entry.compiler(makeContext(mode));
}

/**
 * One-shot helper: registers a CSS file, compiles it in the given mode with
 * cache=false, and returns the output as a string
 * @param mode
 * @param options
 * @param css
 */
async function compile(
	mode: 'serve' | 'build',
	options: StyleCompilerOptions,
	css = '.a{color:red}',
) {
	mockFileContents.clear();
	const file = makeFile();
	setMockFile(file.inputPath, css);
	const fn = await createCompileFn(options, mode);
	const out = await fn(file, () => Promise.resolve(''), undefined, false);
	// The style compiler always returns a string; assert instead of branching
	expect(typeof out).toBe('string');
	return out as string;
}

describe('style-compiler', () => {
	test('compiles CSS with cssnano and preserves the banner', async () => {
		setMockFile('/in/style.css', 'body { background-color: #ffffff; }');
		const compileFn = await createCompileFn({ banner: '/* BANNER */' });

		const result = await compileFn(makeFile('/in/style.css'), () => '');

		expect(result).toBe('/*! BANNER */body{background-color:#fff}');
	});

	test('loads the PostCSS config only once across files when cache is enabled', async () => {
		setMockFile('/in/a.css', 'a { color: #ff0000; }');
		setMockFile('/in/b.css', 'b { color: #00ff00; }');
		const compileFn = await createCompileFn({ banner: '/* B */' });

		await compileFn(makeFile('/in/a.css'), () => '');
		await compileFn(makeFile('/in/b.css'), () => '');

		expect(mockedLoadConfig).toHaveBeenCalledTimes(1);
	});

	test('reloads the PostCSS config per compilation when cache is disabled (serve mode)', async () => {
		setMockFile('/in/a.css', 'a { color: #ff0000; }');
		const compileFn = await createCompileFn({ banner: '/* B */' });

		await compileFn(makeFile('/in/a.css'), () => '', undefined, false);
		await compileFn(makeFile('/in/a.css'), () => '', undefined, false);

		expect(mockedLoadConfig).toHaveBeenCalledTimes(2);
	});

	test('retries processor creation after a failure instead of caching the rejection', async () => {
		setMockFile('/in/a.css', 'a { color: #ff0000; }');
		// First load yields an invalid plugin so postcss() throws during
		// processor creation; second load succeeds
		// @ts-ignore -- intentionally invalid plugin shape
		mockedLoadConfig.mockResolvedValueOnce({ plugins: ['not-a-plugin'] });
		const compileFn = await createCompileFn({ banner: '/* B */' });

		await expect(compileFn(makeFile('/in/a.css'), () => '')).rejects.toThrow();

		// The rejected processor must not be cached: the next file succeeds
		const result = await compileFn(makeFile('/in/a.css'), () => '');
		expect(result).toBe('/*! B */a{color:red}');
	});

	test('warns when the PostCSS config fails to load for a reason other than not existing', async () => {
		setMockFile('/in/a.css', 'a { color: #ff0000; }');
		mockedLoadConfig.mockRejectedValueOnce(
			new Error('Unexpected token in postcss.config.js'),
		);
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const compileFn = await createCompileFn({ banner: '/* B */' });

		// Falls back to the default plugins and still compiles
		const result = await compileFn(makeFile('/in/a.css'), () => '');
		expect(result).toBe('/*! B */a{color:red}');
		expect(warnSpy).toHaveBeenCalledWith(
			'Failed to load PostCSS config: Unexpected token in postcss.config.js',
		);
		warnSpy.mockRestore();
	});

	test('does not warn when no PostCSS config exists', async () => {
		setMockFile('/in/a.css', 'a { color: #ff0000; }');
		mockedLoadConfig.mockRejectedValueOnce(
			new Error('No PostCSS Config found in: /project'),
		);
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const compileFn = await createCompileFn({ banner: '/* B */' });

		const result = await compileFn(makeFile('/in/a.css'), () => '');
		expect(result).toBe('/*! B */a{color:red}');
		expect(warnSpy).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});
});

const SOURCE_MAP_RE = /\/\*#\s*sourceMappingURL=data:application\/json;base64,/;

describe('createStyleCompiler / sourcemap', () => {
	test("defaults to 'onServer': omits source map in build mode", async () => {
		const out = await compile('build', {});
		expect(out).not.toMatch(SOURCE_MAP_RE);
	});

	test("defaults to 'onServer': emits source map in serve mode", async () => {
		const out = await compile('serve', {});
		expect(out).toMatch(SOURCE_MAP_RE);
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
