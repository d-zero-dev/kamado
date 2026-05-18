import type { Context } from 'kamado/config';
import type { CompilableFile, MetaData } from 'kamado/files';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createScriptCompiler } from './script-compiler.js';

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
