import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { build } from 'esbuild';
import { afterEach, describe, expect, test } from 'vitest';

import { bundleOptions } from './build-ui.mjs';

const made: string[] = [];

afterEach(() => {
	for (const root of made.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

/**
 * A project in a directory whose own `tsconfig.json` extends a package that is not installed:
 * what a checkout is to a worktree made inside it.
 * @returns The entry point of the project and its `tsconfig.json`
 */
function nestedProject(): { entry: string; tsconfig: string } {
	const outer = mkdtempSync(path.join(tmpdir(), 'kamado-build-ui-'));
	made.push(outer);
	const project = path.join(outer, 'worktrees', 'project');
	mkdirSync(path.join(project, 'src'), { recursive: true });
	writeFileSync(
		path.join(outer, 'tsconfig.json'),
		JSON.stringify({ extends: ['@nowhere/not-installed'] }),
	);
	writeFileSync(path.join(project, 'tsconfig.json'), JSON.stringify({}));
	writeFileSync(path.join(project, 'src', 'main.ts'), 'export const one: number = 1;\n');
	return {
		entry: path.join(project, 'src', 'main.ts'),
		tsconfig: path.join(project, 'tsconfig.json'),
	};
}

describe('build-ui', () => {
	test('bundles the screen with the tsconfig of the screen, named, and without a warning', async () => {
		const options = bundleOptions();
		expect(options.tsconfig).toBe(
			path.join(
				import.meta.dirname,
				'..',
				'packages',
				'kamado',
				'client',
				'tsconfig.json',
			),
		);
		expect(existsSync(options.tsconfig)).toBe(true);
		// The bundle the script makes, kept in memory: nothing of `dist` is written here.
		const result = await build({ ...options, write: false, logLevel: 'silent' });
		expect(result.warnings).toEqual([]);
		expect(result.outputFiles.map((file) => path.basename(file.path)).toSorted()).toEqual(
			['app.css', 'app.js', 'app.js.LEGAL.txt'],
		);
	});

	test('a tsconfig.json above the project is read, and warned about, only when the tsconfig is looked for', async () => {
		const { entry, tsconfig } = nestedProject();
		const options = {
			entryPoints: [entry],
			// Not the directory the tests run in: the directories above that one are looked into
			// as well, and what they hold is not this test's.
			absWorkingDir: path.dirname(tsconfig),
			bundle: true,
			write: false,
			logLevel: 'silent',
		} as const;
		const looked = await build(options);
		// Whatever the words of the warning are, it names what the tsconfig above extends.
		expect(
			looked.warnings.some((warning) => warning.text.includes('@nowhere/not-installed')),
		).toBe(true);
		const named = await build({ ...options, tsconfig });
		expect(named.warnings).toEqual([]);
		// And what is made is the same.
		expect(named.outputFiles[0]?.text).toBe(looked.outputFiles[0]?.text);
	});
});
