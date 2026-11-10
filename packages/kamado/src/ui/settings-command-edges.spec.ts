import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { checkSettingsOnlyFlag, settingsCommand } from './settings-command.js';
import { createSettingsStore } from './settings.js';

let dir: string;
let file: string;
let config: string;

beforeEach(async () => {
	dir = await realpath(await mkdtemp(path.join(tmpdir(), 'kamado-settings-edges-')));
	file = path.join(dir, 'ui-settings.json');
	const site = path.join(dir, 'site');
	await mkdir(site);
	config = path.join(site, 'kamado.config.jsonc');
	await writeFile(config, '{}');
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const environment = () => ({ cwd: dir, file, resolveConfig: () => config });

describe('a settings file that cannot be used', () => {
	test('delete and reset refuse a file of a newer version and leave it', async () => {
		await writeFile(file, '{"version":2}');
		await expect(settingsCommand(['delete', config], {}, environment())).rejects.toThrow(
			/newer kamado/,
		);
		await expect(settingsCommand(['reset'], {}, environment())).rejects.toThrow(
			/newer kamado/,
		);
	});

	test('delete refuses a broken file and says how to remove it', async () => {
		await writeFile(file, '{ nope');
		await expect(settingsCommand(['delete', config], {}, environment())).rejects.toThrow(
			/delete --all/,
		);
	});

	test('reset of a broken file puts it aside and says so', async () => {
		await writeFile(file, '{ nope');
		const text = await settingsCommand(['reset'], {}, environment());
		expect(text).toMatch(/warning: .*\.bak/);
	});
});

describe('the output', () => {
	test('says there is no project when the file has none', async () => {
		await createSettingsStore(file, config).update({ global: { locale: 'ja' } });
		const text = await settingsCommand(['list'], {}, environment());
		expect(text).toContain('No settings are saved for any project');
		expect(text).toContain('language: ja');
	});

	test('does not pass a control character of the file on to the terminal', async () => {
		const key = '/work/a\u001B[31m/kamado.config.jsonc';
		await createSettingsStore(file, key).update({ project: { pageSize: 100 } });
		const text = await settingsCommand(['list'], {}, environment());
		expect(text).not.toContain('\u001B');
		expect(text).toContain('\\x1b');
	});
});

describe('the flags', () => {
	test.each([
		['--force', { force: true }],
		['--jobs', { jobs: '2' }],
		['--out', { out: 'a.json' }],
		['--open', { open: true }],
		['--no-open', { 'no-open': true }],
		['--skip-unchanged', { 'skip-unchanged': true }],
		['--verbose', { verbose: true }],
		['--cache-dir', { 'cache-dir': 'c' }],
		['--port', { port: '3000' }],
		['--incremental', { incremental: true }],
	])('%s is refused', async (name, flags) => {
		await expect(settingsCommand(['list'], flags, environment())).rejects.toThrow(
			new RegExp(`does not take .*${name}`),
		);
	});

	test('--all is a flag of ui-settings delete, and the others are told so', () => {
		expect(() => checkSettingsOnlyFlag('ui', { all: true })).toThrow(
			/only ui-settings delete does/,
		);
	});
});
