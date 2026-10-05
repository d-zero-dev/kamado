import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
	buildScripts,
	ESBUILD_VERSION,
	findEsbuildBinary,
	type ScriptRequest,
} from './scripts.js';

let root = '';

beforeEach(async () => {
	root = await realpath(await mkdtemp(path.join(tmpdir(), 'kamado-scripts-')));
	await mkdir(path.join(root, 'src'), { recursive: true });
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const OPTIONS: ScriptRequest['options'] = {
	alias: {},
	define: {},
	target: 'es2022',
	minify: false,
	sourcemap: false,
	banner: null,
};

/**
 * A request for the given files of `src`, written to the same names in `out`.
 * @param entries - File names in `src`
 * @param options - Overrides of the shared options
 */
function request(
	entries: readonly string[],
	options: Partial<ScriptRequest['options']> = {},
): ScriptRequest {
	return {
		root,
		options: { ...OPTIONS, ...options },
		entries: entries.map((name, id) => ({
			id,
			input: path.join(root, 'src', name),
			output: path.join(root, 'out', name.replace(/\.[^.]+$/, '.js')),
		})),
	};
}

describe('findEsbuildBinary', () => {
	test('finds the executable of the platform package, which the core can run', () => {
		const binary = findEsbuildBinary();

		expect(binary).toMatch(/node_modules\/@esbuild\/[a-z0-9-]+\/bin\/esbuild$/);
		expect(execFileSync(binary!, ['--version'], { encoding: 'utf8' }).trim()).toBe(
			ESBUILD_VERSION,
		);
	});
});

describe('buildScripts', () => {
	test('exposes the version of esbuild for the cache digest', () => {
		expect(ESBUILD_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
	});

	test('bundles a TypeScript entry with its imports and reports every input', async () => {
		await writeFile(
			path.join(root, 'src', 'util.ts'),
			'export const twice = (n: number): number => n * 2;\n',
		);
		await writeFile(
			path.join(root, 'src', 'app.ts'),
			"import { twice } from './util';\nconsole.log(twice(21));\n",
		);

		const [out] = await buildScripts(request(['app.ts']));

		expect(out!.id).toBe(0);
		expect(out!.code).toContain('twice');
		expect(out!.code).not.toContain('import ');
		expect(out!.inputs.toSorted()).toEqual([
			path.join(root, 'src', 'app.ts'),
			path.join(root, 'src', 'util.ts'),
		]);
	});

	test('minify, banner, define and alias are applied', async () => {
		await mkdir(path.join(root, 'lib'));
		await writeFile(path.join(root, 'lib', 'greet.ts'), "export const greet = 'hi';\n");
		await writeFile(
			path.join(root, 'src', 'app.ts'),
			"import { greet } from '@/greet';\nconsole.log(greet, MODE);\n",
		);

		const [out] = await buildScripts(
			request(['app.ts'], {
				minify: true,
				banner: '/*\nrev. 2026-01-02\n*/',
				define: { MODE: '"production"' },
				alias: { '@': path.join(root, 'lib') },
			}),
		);

		expect(out!.code).toBe(
			'/*\nrev. 2026-01-02\n*/\n(()=>{console.log("hi","production");})();\n',
		);
	});

	test('an inline source map is appended only when asked for', async () => {
		await writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');

		const [without] = await buildScripts(request(['a.ts']));
		const [withMap] = await buildScripts(request(['a.ts'], { sourcemap: true }));

		expect(without!.code).not.toContain('sourceMappingURL');
		expect(withMap!.code).toContain('//# sourceMappingURL=data:application/json;base64,');
	});

	test('several entries come back in the order of the request', async () => {
		const names = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];
		for (const name of names) {
			await writeFile(path.join(root, 'src', name), `console.log('${name}');\n`);
		}

		const outs = await buildScripts(request(names));

		expect(outs.map((o) => o.id)).toEqual([0, 1, 2, 3]);
		// esbuild prints string literals with double quotes.
		expect(outs.map((o) => /"([a-d]\.ts)"/.exec(o.code)?.[1])).toEqual(names);
	});

	test('a script that cannot be resolved fails with the message of esbuild', async () => {
		await writeFile(path.join(root, 'src', 'bad.ts'), "import './missing';\n");

		await expect(buildScripts(request(['bad.ts']))).rejects.toThrow(/Could not resolve/);
	});
});
