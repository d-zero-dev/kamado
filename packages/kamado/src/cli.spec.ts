/**
 * The command line as a person runs it: the built `dist/cli.js` in a process of its own, with
 * the settings file in a temporary directory. `cli.ts` runs `main()` when it is loaded, so it
 * cannot be imported by a test; what the commands refuse, and that `ui-settings` reads the file
 * `KAMADO_UI_SETTINGS` names, are checked here. `yarn build` comes before `yarn test`.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createSettingsStore } from './ui/settings.js';

const run = promisify(execFile);
const CLI = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'dist',
	'cli.js',
);

let dir: string;
let file: string;
let config: string;

beforeEach(async () => {
	if (!existsSync(CLI)) {
		throw new Error(`${CLI} is not built: run yarn build first`);
	}
	dir = await realpath(await mkdtemp(path.join(tmpdir(), 'kamado-cli-')));
	file = path.join(dir, 'ui-settings.json');
	config = path.join(dir, 'kamado.config.jsonc');
	await writeFile(config, '{}');
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/**
 * Runs the command line.
 * @param args - The arguments
 * @returns The exit code and what was printed
 */
async function kamado(...args: string[]) {
	try {
		const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
			cwd: dir,
			env: { ...process.env, KAMADO_UI_SETTINGS: file, NO_COLOR: '1' },
		});
		return { code: 0, stdout, stderr };
	} catch (error) {
		const failed = error as { code?: number; stdout?: string; stderr?: string };
		return {
			code: failed.code ?? -1,
			stdout: failed.stdout ?? '',
			stderr: failed.stderr ?? '',
		};
	}
}

describe('kamado ui-settings', () => {
	test('lists what the settings file named by KAMADO_UI_SETTINGS holds', async () => {
		await createSettingsStore(file, config).update({ project: { pageSize: 100 } });
		const result = await kamado('ui-settings', 'list');
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(config);
		expect(result.stdout).toContain(file);
	});

	test('reset removes the project of the config file of the directory', async () => {
		await createSettingsStore(file, config).update({ project: { pageSize: 100 } });
		const reset = await kamado('ui-settings', 'reset');
		expect(reset.code).toBe(0);
		expect(reset.stdout).toContain('Reset the settings of');
		const listed = await kamado('ui-settings', 'list');
		expect(listed.stdout).toContain('No settings are saved for any project');
	});

	test('delete --all removes the file', async () => {
		await createSettingsStore(file, config).update({ project: { pageSize: 100 } });
		const result = await kamado('ui-settings', 'delete', '--all');
		expect(result.code).toBe(0);
		expect(result.stdout).toContain('Deleted');
	});

	test('a subcommand that is not one, and a delete with nothing to delete, are errors', async () => {
		const unknown = await kamado('ui-settings', 'wipe');
		expect(unknown.code).toBe(1);
		expect(unknown.stderr).toContain('list, reset or delete');
		const nothing = await kamado('ui-settings', 'delete');
		expect(nothing.code).toBe(1);
		expect(nothing.stderr).toContain('delete takes the path');
	});
});

describe('--all', () => {
	test.each(['build', 'server', 'pages', 'ui'])('is refused by %s', async (command) => {
		const result = await kamado(command, '--all');
		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			`${command} does not take --all (only ui-settings delete does)`,
		);
	});
});
