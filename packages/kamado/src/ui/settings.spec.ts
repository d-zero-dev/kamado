import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
	createSettingsStore,
	defaultSettingsFile,
	listSettings,
	parsePatch,
	parseSettings,
	readSettingsFile,
	removeAllSettings,
	removeProjectSettings,
} from './settings.js';

let dir: string;
let file: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'kamado-settings-'));
	file = path.join(dir, 'config', 'ui-settings.json');
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const KEY_A = '/work/a/kamado.config.jsonc';
const KEY_B = '/work/b/kamado.config.jsonc';

describe('defaultSettingsFile', () => {
	test('is ~/.config/kamado/ui-settings.json', () => {
		expect(defaultSettingsFile({}, '/home/u')).toBe(
			path.join('/home/u', '.config', 'kamado', 'ui-settings.json'),
		);
	});
	test('KAMADO_UI_SETTINGS replaces it', () => {
		expect(defaultSettingsFile({ KAMADO_UI_SETTINGS: '/tmp/x.json' }, '/home/u')).toBe(
			'/tmp/x.json',
		);
	});
	test('an empty KAMADO_UI_SETTINGS is not a file', () => {
		expect(defaultSettingsFile({ KAMADO_UI_SETTINGS: '' }, '/home/u')).toBe(
			path.join('/home/u', '.config', 'kamado', 'ui-settings.json'),
		);
	});
});

describe('parseSettings', () => {
	test('reads what it writes', () => {
		const text = JSON.stringify({
			version: 1,
			global: { locale: 'ja' },
			projects: { [KEY_A]: { updatedAt: '2026-01-02T03:04:05.000Z', pageSize: 100 } },
		});
		expect(parseSettings(text)).toEqual({
			state: 'ok',
			settings: {
				version: 1,
				global: { locale: 'ja' },
				projects: { [KEY_A]: { updatedAt: '2026-01-02T03:04:05.000Z', pageSize: 100 } },
			},
		});
	});
	test('a value that is not allowed falls back to the default, and what is not known is dropped', () => {
		const parsed = parseSettings(
			JSON.stringify({
				version: 1,
				global: { locale: 'fr', extra: 1 },
				projects: { [KEY_A]: { pageSize: 7, other: true } },
			}),
		);
		expect(parsed).toEqual({
			state: 'ok',
			settings: {
				version: 1,
				global: { locale: 'auto' },
				projects: { [KEY_A]: { updatedAt: '', pageSize: 500 } },
			},
		});
	});
	test.each([
		['text that is not JSON', '{'],
		['JSON that is not an object', '[]'],
		['no version', '{}'],
		['a version that is not a whole number', '{"version":"1"}'],
		['a global that is not an object', '{"version":1,"global":[]}'],
		['projects that is not an object', '{"version":1,"projects":[]}'],
		['an entry of projects that is not an object', '{"version":1,"projects":{"/a":"x"}}'],
	])('%s is broken', (_name, text) => {
		expect(parseSettings(text).state).toBe('broken');
	});
	test('a version after this one is not broken: it is newer', () => {
		expect(parseSettings('{"version":2,"anything":true}')).toEqual({
			state: 'newer',
			version: 2,
		});
	});
});

describe('parsePatch', () => {
	test('takes the locale and the page size', () => {
		expect(parsePatch({ global: { locale: 'en' }, project: { pageSize: 1000 } })).toEqual(
			{
				global: { locale: 'en' },
				project: { pageSize: 1000 },
			},
		);
	});
	test('drops what it does not know', () => {
		expect(parsePatch({ global: { x: 1 }, extra: 1 })).toEqual({});
	});
	test.each([
		['a body that is not an object', []],
		['a locale that is not one', { global: { locale: 'fr' } }],
		['a page size that is not one', { project: { pageSize: 7 } }],
		['a global that is not an object', { global: 'ja' }],
	])('refuses %s', (_name, value) => {
		expect(() => parsePatch(value)).toThrow();
	});
});

describe('the store', () => {
	test('has the defaults before anything is saved, and writes no file by being read', async () => {
		const store = createSettingsStore(file, KEY_A);
		await expect(store.open()).resolves.toEqual({ warning: null });
		await expect(store.view()).resolves.toEqual({
			global: { locale: 'auto' },
			project: null,
			warning: null,
		});
		await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	test('saves the settings of a project apart from those of another', async () => {
		const a = createSettingsStore(file, KEY_A);
		const b = createSettingsStore(file, KEY_B);
		await a.update({ project: { pageSize: 100 } });
		await b.update({ project: { pageSize: 5000 }, global: { locale: 'ja' } });
		const viewA = await a.view();
		expect(viewA.project?.pageSize).toBe(100);
		expect(viewA.global.locale).toBe('ja');
		const viewB = await b.view();
		expect(viewB.project?.pageSize).toBe(5000);
	});

	test('a save keeps what the other projects hold, whoever wrote it meanwhile', async () => {
		const a = createSettingsStore(file, KEY_A);
		await a.update({ project: { pageSize: 100 } });
		const other = createSettingsStore(file, KEY_B);
		await other.update({ project: { pageSize: 1000 } });
		await a.update({ project: { pageSize: 500 } });
		const read = await readSettingsFile(file);
		expect(read.state === 'ok' && Object.keys(read.settings.projects).toSorted()).toEqual(
			[KEY_A, KEY_B],
		);
	});

	test('saves at the same time without losing a project', async () => {
		const keys = Array.from({ length: 8 }, (_, i) => `/work/${i}/kamado.config.jsonc`);
		await Promise.all(
			keys.map((key) =>
				createSettingsStore(file, key).update({ project: { pageSize: 100 } }),
			),
		);
		const read = await readSettingsFile(file);
		expect(read.state === 'ok' && Object.keys(read.settings.projects).toSorted()).toEqual(
			keys.toSorted(),
		);
	});

	test('writes the file readable by its owner only, and leaves no lock or temporary file', async () => {
		await createSettingsStore(file, KEY_A).update({ project: { pageSize: 100 } });
		if (process.platform !== 'win32') {
			const info = await stat(file);
			expect(info.mode & 0o777).toBe(0o600);
		}
		expect(await readdir(path.dirname(file))).toEqual(['ui-settings.json']);
	});

	test('puts a file that is broken aside and starts again, saying so without the path', async () => {
		await createSettingsStore(file, KEY_A).update({ project: { pageSize: 100 } });
		await writeFile(file, '{ not json');
		const store = createSettingsStore(file, KEY_A);
		const { warning } = await store.open();
		expect(warning).toMatch(/ui-settings\.json/);
		expect(warning).toMatch(/\.bak/);
		expect(warning).not.toContain(dir);
		const names = await readdir(path.dirname(file));
		const backup = names.find((name) => name.endsWith('.bak'));
		expect(backup).toMatch(/^ui-settings\.json\.\d{14}\.bak$/);
		expect(await readFile(path.join(path.dirname(file), backup ?? ''), 'utf8')).toBe(
			'{ not json',
		);
		const afterOpen = await store.view();
		expect(afterOpen.warning).toBe(warning);
		await store.update({ project: { pageSize: 1000 } });
		const afterUpdate = await store.view();
		expect(afterUpdate.project?.pageSize).toBe(1000);
	});

	test('leaves a file of a newer version as it is and does not write it', async () => {
		const text = '{"version":2,"projects":{"x":{}}}';
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, text);
		const store = createSettingsStore(file, KEY_A);
		const { warning } = await store.open();
		expect(warning).toMatch(/newer/);
		expect(warning).not.toContain(dir);
		const error = await store
			.update({ project: { pageSize: 100 } })
			.catch((error_: unknown) => error_);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toMatch(/newer/);
		expect((error as Error).message).not.toContain(dir);
		expect(await readFile(file, 'utf8')).toBe(text);
		expect(await readdir(path.dirname(file))).toEqual(['ui-settings.json']);
	});
});

describe('listing and removing', () => {
	test('lists the projects that have settings', async () => {
		await createSettingsStore(file, KEY_A).update({ project: { pageSize: 100 } });
		await createSettingsStore(file, KEY_B).update({ project: { pageSize: 500 } });
		const listed = await listSettings(file);
		expect(listed.state).toBe('ok');
		expect(listed.state === 'ok' && listed.projects.map((p) => p.key).toSorted()).toEqual(
			[KEY_A, KEY_B],
		);
	});
	test('says a file that cannot be read, and does not touch it', async () => {
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, '{ not json');
		const listed = await listSettings(file);
		expect(listed.state).toBe('broken');
		expect(await readFile(file, 'utf8')).toBe('{ not json');
		expect(await readdir(path.dirname(file))).toEqual(['ui-settings.json']);
	});
	test('says there is nothing when there is no file', async () => {
		const listed = await listSettings(file);
		expect(listed.state).toBe('missing');
	});
	test('removes one project and says whether it had settings', async () => {
		await createSettingsStore(file, KEY_A).update({ project: { pageSize: 100 } });
		await createSettingsStore(file, KEY_B).update({ project: { pageSize: 500 } });
		await expect(removeProjectSettings(file, KEY_A)).resolves.toMatchObject({
			removed: true,
		});
		await expect(removeProjectSettings(file, KEY_A)).resolves.toMatchObject({
			removed: false,
		});
		const listed = await listSettings(file);
		expect(listed.state === 'ok' && listed.projects.map((p) => p.key)).toEqual([KEY_B]);
	});
	test('does not create a file to remove from', async () => {
		await expect(removeProjectSettings(file, KEY_A)).resolves.toMatchObject({
			removed: false,
		});
		await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
	});
	test('removes the file with everything in it', async () => {
		await createSettingsStore(file, KEY_A).update({ global: { locale: 'ja' } });
		await expect(removeAllSettings(file)).resolves.toBe(true);
		await expect(removeAllSettings(file)).resolves.toBe(false);
		await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
	});
});
