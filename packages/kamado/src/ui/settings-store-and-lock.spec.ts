import {
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	utimes,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
	createSettingsStore,
	defaultSettingsFile,
	removeProjectSettings,
	withLock,
} from './settings.js';

let dir: string;
let file: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'kamado-settings-robust-'));
	file = path.join(dir, 'ui-settings.json');
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('the settings file', () => {
	test('a relative KAMADO_UI_SETTINGS is made absolute, so that every directory sees the same file', () => {
		const named = defaultSettingsFile({ KAMADO_UI_SETTINGS: 'x.json' }, '/h');
		expect(path.isAbsolute(named)).toBe(true);
		expect(named).toBe(path.resolve('x.json'));
	});
});

describe('the store', () => {
	test('a file that went bad after the start is put aside by the next save, and the screen is told', async () => {
		const store = createSettingsStore(file, '/work/a/kamado.config.jsonc');
		await store.update({ project: { pageSize: 100 } });
		await expect(store.open()).resolves.toEqual({ warning: null });
		await writeFile(file, '{ went bad');
		const view = await store.update({ project: { pageSize: 1000 } });
		expect(view.warning).toMatch(/\.bak/);
		expect(view.project?.pageSize).toBe(1000);
	});

	test('a project key that names something of Object.prototype is data, and the size keeps its default', async () => {
		const store = createSettingsStore(file, '__proto__');
		const view = await store.update({ project: {} });
		expect(view.project?.pageSize).toBe(500);
		expect(({} as { pageSize?: number }).pageSize).toBeUndefined();
	});
});

describe('a save of nothing', () => {
	test('does not create the file', async () => {
		const store = createSettingsStore(file, '/work/a/kamado.config.jsonc');
		await store.update({});
		await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	test('does not write the file again, so a field this version does not know stays', async () => {
		const text = '{"version":1,"projects":{"/work/b":{"pageSize":100,"future":1}}}';
		await writeFile(file, text);
		const store = createSettingsStore(file, '/work/a/kamado.config.jsonc');
		await store.update({});
		await removeProjectSettings(file, '/work/a/kamado.config.jsonc');
		expect(await readFile(file, 'utf8')).toBe(text);
	});

	test('does not make the directory or the lock', async () => {
		const store = createSettingsStore(file, '/work/a/kamado.config.jsonc');
		await store.update({});
		await removeProjectSettings(file, '/work/a/kamado.config.jsonc');
		await expect(stat(dir)).resolves.toBeDefined();
		expect(await readdir(dir)).toEqual([]);
	});

	test('a project that has no settings is removed from a file that exists without taking the lock', async () => {
		await writeFile(file, '{"version":1,"projects":{"/work/b":{"pageSize":100}}}');
		await writeFile(`${file}.lock`, 'another kamado');
		const result = await removeProjectSettings(file, '/work/a/kamado.config.jsonc');
		expect(result).toEqual({ removed: false, warning: null });
	});

	test('a file of a newer version is said at the start and is not changed', async () => {
		const text = '{"version":2}';
		await writeFile(file, text);
		const store = createSettingsStore(file, '/work/a/kamado.config.jsonc');
		const { warning } = await store.open();
		expect(warning).toMatch(/newer/);
		expect(await readFile(file, 'utf8')).toBe(text);
	});
});

describe('the warning of the start', () => {
	test('goes when the file is whole again after a save', async () => {
		await writeFile(file, '{ broken');
		const store = createSettingsStore(file, '/work/a/kamado.config.jsonc');
		const { warning } = await store.open();
		expect(warning).toMatch(/\.bak/);
		const view = await store.update({ project: { pageSize: 100 } });
		expect(view.warning).toBeNull();
	});
});

describe('the file put aside', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test('twice in a second keeps both, the second under another name', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-01-02T03:04:05Z'));
		const store = createSettingsStore(file, '/work/a/kamado.config.jsonc');
		await writeFile(file, '{ first');
		await store.update({ project: { pageSize: 100 } });
		await writeFile(file, '{ second');
		await store.update({ project: { pageSize: 100 } });
		const names = await readdir(dir);
		const backups = names.filter((name) => name.endsWith('.bak')).toSorted();
		expect(backups).toEqual([
			'ui-settings.json.20260102030405-1.bak',
			'ui-settings.json.20260102030405.bak',
		]);
		const contents = await Promise.all(
			backups.map((name) => readFile(path.join(dir, name), 'utf8')),
		);
		expect(contents.toSorted()).toEqual(['{ first', '{ second']);
	});
});

describe('the lock', () => {
	test('one that is held is waited for, and then refused as locked', async () => {
		const lock = `${file}.lock`;
		await writeFile(lock, 'another kamado');
		const error = await withLock(file, async () => {}, { attempts: 3, pauseMs: 1 }).catch(
			(error_: unknown) => error_,
		);
		expect(error).toMatchObject({ name: 'SettingsError', code: 'locked' });
		expect((error as Error).message).not.toContain(dir);
		expect(await readFile(lock, 'utf8')).toBe('another kamado');
	});

	test('a lock older than the limit is taken over, and the file is written', async () => {
		const lock = `${file}.lock`;
		await writeFile(lock, 'a process that died');
		const old = new Date(Date.now() - 60_000);
		await utimes(lock, old, old);
		const store = createSettingsStore(file, '/work/a/kamado.config.jsonc');
		const view = await store.update({ project: { pageSize: 100 } });
		expect(view.project?.pageSize).toBe(100);
		await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	test('is removed by the process that owns it', async () => {
		await withLock(file, async () => {});
		await expect(stat(`${file}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	test('that another process took over (it looked stale) is not removed by the one that lost it', async () => {
		const lock = `${file}.lock`;
		await withLock(file, async () => {
			await writeFile(lock, 'the other process');
		});
		expect(await readFile(lock, 'utf8')).toBe('the other process');
	});
});
