import type { CompilableFile } from 'kamado/files';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';

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
