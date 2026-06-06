import type { StyleCompilerOptions } from './style-compiler.js';
import type { CompilableFile, FileContent } from 'kamado/files';

// eslint-disable-next-line import-x/default
import postcssLoadConfig from 'postcss-load-config';
import { describe, test, expect, vi, beforeEach } from 'vitest';

import { createStyleCompiler } from './style-compiler.js';

// Mock file content storage for tests
const mockFileContents = new Map<string, FileContent>();

vi.mock('kamado/files', async (importOriginal) => {
	const original = await importOriginal();
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

/**
 * Helper to create a minimal CompilableFile for tests
 * @param inputPath
 */
function createFile(inputPath: string): CompilableFile {
	return {
		inputPath,
		outputPath: inputPath,
		fileSlug: 'style',
		filePathStem: '/style',
		url: '/style.css',
		extension: '.css',
		date: new Date(),
	};
}

/**
 * Helper to create the innermost compile function
 * @param options
 */
async function createCompileFn(options?: StyleCompilerOptions) {
	const entry = createStyleCompiler()(options);
	// @ts-ignore -- context is unused by the style compiler
	return await entry.compiler({});
}

describe('style-compiler', () => {
	beforeEach(() => {
		mockFileContents.clear();
		mockedLoadConfig.mockReset();
		// @ts-ignore -- minimal config shape for tests
		mockedLoadConfig.mockResolvedValue({ plugins: [] });
	});

	test('compiles CSS with cssnano and prepends the banner', async () => {
		mockFileContents.set('/in/style.css', {
			metaData: {},
			content: 'body { background-color: #ffffff; }',
			raw: 'body { background-color: #ffffff; }',
		});
		const compile = await createCompileFn({ banner: '/* BANNER */' });

		const result = await compile(createFile('/in/style.css'), () => '');

		expect(result).toBe('/* BANNER */\nbody{background-color:#fff}');
	});

	test('loads the PostCSS config only once across files when cache is enabled', async () => {
		mockFileContents.set('/in/a.css', {
			metaData: {},
			content: 'a { color: #ff0000; }',
			raw: 'a { color: #ff0000; }',
		});
		mockFileContents.set('/in/b.css', {
			metaData: {},
			content: 'b { color: #00ff00; }',
			raw: 'b { color: #00ff00; }',
		});
		const compile = await createCompileFn({ banner: '/* B */' });

		await compile(createFile('/in/a.css'), () => '');
		await compile(createFile('/in/b.css'), () => '');

		expect(mockedLoadConfig).toHaveBeenCalledTimes(1);
	});

	test('reloads the PostCSS config per compilation when cache is disabled (serve mode)', async () => {
		mockFileContents.set('/in/a.css', {
			metaData: {},
			content: 'a { color: #ff0000; }',
			raw: 'a { color: #ff0000; }',
		});
		const compile = await createCompileFn({ banner: '/* B */' });

		await compile(createFile('/in/a.css'), () => '', undefined, false);
		await compile(createFile('/in/a.css'), () => '', undefined, false);

		expect(mockedLoadConfig).toHaveBeenCalledTimes(2);
	});

	test('retries processor creation after a failure instead of caching the rejection', async () => {
		mockFileContents.set('/in/a.css', {
			metaData: {},
			content: 'a { color: #ff0000; }',
			raw: 'a { color: #ff0000; }',
		});
		// First load yields an invalid plugin so postcss() throws during
		// processor creation; second load succeeds
		// @ts-ignore -- intentionally invalid plugin shape
		mockedLoadConfig.mockResolvedValueOnce({ plugins: ['not-a-plugin'] });
		const compile = await createCompileFn({ banner: '/* B */' });

		await expect(compile(createFile('/in/a.css'), () => '')).rejects.toThrow();

		// The rejected processor must not be cached: the next file succeeds
		const result = await compile(createFile('/in/a.css'), () => '');
		expect(result).toBe('/* B */\na{color:red}');
	});

	test('warns when the PostCSS config fails to load for a reason other than not existing', async () => {
		mockFileContents.set('/in/a.css', {
			metaData: {},
			content: 'a { color: #ff0000; }',
			raw: 'a { color: #ff0000; }',
		});
		mockedLoadConfig.mockRejectedValueOnce(
			new Error('Unexpected token in postcss.config.js'),
		);
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const compile = await createCompileFn({ banner: '/* B */' });

		// Falls back to the default plugins and still compiles
		const result = await compile(createFile('/in/a.css'), () => '');
		expect(result).toBe('/* B */\na{color:red}');
		expect(warnSpy).toHaveBeenCalledWith(
			'Failed to load PostCSS config: Unexpected token in postcss.config.js',
		);
		warnSpy.mockRestore();
	});

	test('does not warn when no PostCSS config exists', async () => {
		mockFileContents.set('/in/a.css', {
			metaData: {},
			content: 'a { color: #ff0000; }',
			raw: 'a { color: #ff0000; }',
		});
		mockedLoadConfig.mockRejectedValueOnce(
			new Error('No PostCSS Config found in: /project'),
		);
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const compile = await createCompileFn({ banner: '/* B */' });

		const result = await compile(createFile('/in/a.css'), () => '');
		expect(result).toBe('/* B */\na{color:red}');
		expect(warnSpy).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});
});
