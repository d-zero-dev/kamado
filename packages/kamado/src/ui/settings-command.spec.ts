import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { checkSettingsOnlyFlag, settingsCommand } from './settings-command.js';
import { createSettingsStore, listSettings } from './settings.js';

let dir: string;
let file: string;
let site: string;
let config: string;

beforeEach(async () => {
	dir = await realpath(await mkdtemp(path.join(tmpdir(), 'kamado-settings-command-')));
	file = path.join(dir, 'ui-settings.json');
	site = path.join(dir, 'site');
	await mkdir(site);
	config = path.join(site, 'kamado.config.jsonc');
	await writeFile(config, '{}');
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/**
 * The environment of the command.
 * @param resolve - What the config lookup does
 */
function environment(resolve: () => string = () => config) {
	return { cwd: dir, file, resolveConfig: resolve };
}

const GONE = '/gone/kamado.config.jsonc';

/**
 * Saves settings for projects.
 * @param keys - The projects
 */
async function save(...keys: string[]): Promise<void> {
	for (const key of keys) {
		await createSettingsStore(file, key).update({ project: { pageSize: 100 } });
	}
}

describe('ui-settings list', () => {
	test('says there is nothing when no settings were saved', async () => {
		await expect(settingsCommand(['list'], {}, environment())).resolves.toContain(
			'No settings are saved',
		);
	});
	test('lists the projects, and marks one whose config file is gone', async () => {
		await save(config, GONE);
		const text = await settingsCommand(['list'], {}, environment());
		expect(text).toContain(config);
		expect(text).toContain(GONE);
		const lines = text.split('\n');
		expect(lines.find((line) => line.includes(GONE))).toContain('config file not found');
		expect(lines.find((line) => line.includes(config))).not.toContain('not found');
	});
	test('says a file that cannot be read, and leaves it', async () => {
		await writeFile(file, '{ nope');
		await expect(settingsCommand(['list'], {}, environment())).resolves.toContain(
			'cannot be read',
		);
		const listed = await listSettings(file);
		expect(listed.state).toBe('broken');
	});
});

describe('ui-settings reset', () => {
	test('removes the settings of the project of the config file', async () => {
		await save(config, GONE);
		const text = await settingsCommand(['reset'], {}, environment());
		expect(text).toContain(config);
		const listed = await listSettings(file);
		expect(listed.state === 'ok' && listed.projects.map((p) => p.key)).toEqual([GONE]);
	});
	test('says so when the project had none', async () => {
		await expect(settingsCommand(['reset'], {}, environment())).resolves.toContain(
			'No settings were saved',
		);
	});
	test('looks for the config file only here', async () => {
		await expect(
			settingsCommand(
				['reset'],
				{},
				environment(() => {
					throw new Error('config file not found: x');
				}),
			),
		).rejects.toThrow(/config file not found/);
	});
});

describe('ui-settings delete', () => {
	test('removes the project of a config file given by path', async () => {
		await save(config, GONE);
		await settingsCommand(['delete', 'site/kamado.config.jsonc'], {}, environment());
		const listed = await listSettings(file);
		expect(listed.state === 'ok' && listed.projects.map((p) => p.key)).toEqual([GONE]);
	});
	test('takes the directory of the config file too', async () => {
		await save(config);
		await settingsCommand(['delete', 'site'], {}, environment());
		const listed = await listSettings(file);
		expect(listed.state === 'ok' && listed.projects).toEqual([]);
	});
	test('removes a project whose config file is gone, by the path as listed', async () => {
		await save(GONE);
		await settingsCommand(['delete', GONE], {}, environment());
		const listed = await listSettings(file);
		expect(listed.state === 'ok' && listed.projects).toEqual([]);
	});
	test('refuses a project that has no settings', async () => {
		await save(config);
		await expect(
			settingsCommand(['delete', '/nowhere/kamado.config.jsonc'], {}, environment()),
		).rejects.toThrow(/no settings are saved/);
	});
	test('--all removes the file', async () => {
		await save(config, GONE);
		await expect(
			settingsCommand(['delete'], { all: true }, environment()),
		).resolves.toContain('Deleted');
		const listed = await listSettings(file);
		expect(listed.state).toBe('missing');
	});
	test.each([
		['nothing to delete', ['delete'], {}],
		['a path and --all', ['delete', 'a'], { all: true }],
		['two paths', ['delete', 'a', 'b'], {}],
	])('refuses %s', async (_name, positionals, flags) => {
		await expect(settingsCommand(positionals, flags, environment())).rejects.toThrow(
			/delete/,
		);
	});
});

describe('ui-settings arguments', () => {
	test.each([
		['no subcommand', [], {}, /list, reset or delete/],
		['an unknown subcommand', ['wipe'], {}, /list, reset or delete/],
		['an argument to list', ['list', 'x'], {}, /list takes no arguments/],
		['an argument to reset', ['reset', 'x'], {}, /reset takes no arguments/],
		['--all with list', ['list'], { all: true }, /--all/],
		['--all with reset', ['reset'], { all: true }, /--all/],
		['--config with list', ['list'], { config: 'a' }, /--config/],
		['--config with delete', ['delete', 'x'], { config: 'a' }, /--config/],
		['--port', ['list'], { port: '1' }, /does not take --port/],
		['--incremental', ['list'], { incremental: true }, /does not take --incremental/],
		['--cache-dir', ['list'], { 'cache-dir': 'c' }, /does not take --cache-dir/],
	])('refuses %s before anything is read', async (_name, positionals, flags, message) => {
		await expect(settingsCommand(positionals, flags, environment())).rejects.toThrow(
			message,
		);
	});
});

describe('checkSettingsOnlyFlag', () => {
	test('refuses --all for the other commands', () => {
		expect(() => checkSettingsOnlyFlag('build', { all: true })).toThrow(
			/build does not take --all \(only ui-settings delete does\)/,
		);
		expect(() => checkSettingsOnlyFlag('build', {})).not.toThrow();
	});
});
