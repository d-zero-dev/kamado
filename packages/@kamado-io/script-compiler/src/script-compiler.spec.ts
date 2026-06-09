import type { Context } from 'kamado/config';
import type { CompilableFile, MetaData } from 'kamado/files';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
	describe,
	test,
	expect,
	vi,
	beforeAll,
	afterAll,
	beforeEach,
	afterEach,
} from 'vitest';

import { createScriptCompiler } from './script-compiler.js';

let tmpDir: string;

/**
 * Helper to create a minimal CompilableFile for tests
 * @param inputPath
 * @param outputPath
 */
function createFile(inputPath: string, outputPath: string): CompilableFile {
	return {
		inputPath,
		outputPath,
		fileSlug: 'main',
		filePathStem: '/main',
		url: '/main.js',
		extension: '.ts',
		date: new Date(),
	};
}

/**
 * Helper to create the innermost compile function
 * @param options
 */
async function createCompileFn(
	options?: Parameters<ReturnType<typeof createScriptCompiler>>[0],
) {
	const entry = createScriptCompiler()(options);
	// @ts-ignore -- context is unused by the script compiler
	return await entry.compiler({});
}

beforeAll(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kamado-script-compiler-'));
	await fs.writeFile(
		path.join(tmpDir, 'util.ts'),
		'export const MSG: string = "HELLO_FROM_UTIL";\n',
	);
	await fs.writeFile(
		path.join(tmpDir, 'entry.ts'),
		"import { MSG } from './util';\nconsole.log(MSG);\n",
	);
	await fs.writeFile(path.join(tmpDir, 'style.css'), 'body { color: red; }\n');
	await fs.writeFile(
		path.join(tmpDir, 'entry-with-css.ts'),
		"import './style.css';\nimport { MSG } from './util';\nconsole.log(MSG);\n",
	);
});

afterAll(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('script-compiler', () => {
	test('bundles imported modules and prepends the banner', async () => {
		const compile = await createCompileFn({ banner: '/* BANNER */' });
		const file = createFile(
			path.join(tmpDir, 'entry.ts'),
			path.join(tmpDir, 'out', 'main.js'),
		);

		// @ts-ignore -- compile/log/cache are unused by the script compiler
		const result = await compile(file, () => '');

		expect(typeof result).toBe('string');
		const code = result as string;
		expect(code.startsWith('/* BANNER */')).toBe(true);
		// The imported module is bundled in
		expect(code).toContain('HELLO_FROM_UTIL');
		// No write to the real output path happened (write: false)
		await expect(fs.access(file.outputPath)).rejects.toThrow();
	});

	test('returns the JS bundle (not the extracted CSS) when the entry imports CSS', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const compile = await createCompileFn({ banner: '/* BANNER */' });
		const file = createFile(
			path.join(tmpDir, 'entry-with-css.ts'),
			path.join(tmpDir, 'out', 'main-with-css.js'),
		);

		// @ts-ignore -- compile/log/cache are unused by the script compiler
		const result = await compile(file, () => '');

		const code = result as string;
		// JS bundle is selected by output path, not by array position
		expect(code).toContain('HELLO_FROM_UTIL');
		expect(code).not.toContain('color: red');
		// The extracted CSS output is reported as ignored
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(String(warnSpy.mock.calls[0]?.[0])).toContain('main-with-css.css');
		warnSpy.mockRestore();
	});
});

let workDir: string;

beforeEach(async () => {
	workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'script-compiler-spec-'));
});

afterEach(async () => {
	await fs.rm(workDir, { recursive: true, force: true });
});

/**
 *
 * @param mode
 */
function makeContext(mode: 'serve' | 'build'): Context<MetaData> {
	return {
		mode,
		pkg: { name: 'test', version: '1.0.0' },
		dir: { root: workDir, input: workDir, output: workDir },
		devServer: { port: 3000, host: 'localhost', open: false, transforms: [] },
		compilers: () => [],
	} as Context<MetaData>;
}

/**
 *
 * @param mode
 * @param options
 * @param source
 */
async function compile(
	mode: 'serve' | 'build',
	options: Parameters<ReturnType<typeof createScriptCompiler<MetaData>>>[0],
	source = 'export const answer = 42;\n',
) {
	const inputPath = path.join(workDir, 'entry.ts');
	await fs.writeFile(inputPath, source, 'utf8');
	// outputPath is appended to os.tmpdir() inside the compiler; make it unique
	// per call so parallel workers don't collide.
	const uniqueOutput = path.join(path.basename(workDir), 'entry.js');
	const file: CompilableFile = {
		inputPath,
		outputPath: uniqueOutput,
		fileSlug: 'entry',
		filePathStem: path.join(workDir, 'entry'),
		url: '/entry.js',
		extension: '.ts',
		date: new Date(),
	};
	const entry = createScriptCompiler<MetaData>()(options);
	const fn = await entry.compiler(makeContext(mode));
	const out = await fn(file, () => Promise.resolve(''), undefined, false);
	return typeof out === 'string' ? out : new TextDecoder().decode(out);
}

const SOURCE_MAP_RE = /\/\/#\s*sourceMappingURL=data:application\/json;base64,/;

describe('createScriptCompiler / sourcemap', () => {
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
