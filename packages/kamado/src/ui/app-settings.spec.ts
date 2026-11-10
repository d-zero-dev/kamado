import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createUiApp, TOKEN_HEADER } from './app.js';
import { createSettingsStore } from './settings.js';

const TOKEN = 'a-token-for-the-test';
const KEY = '/home/u/site/kamado.config.jsonc';
const ROOTS = {
	rootDir: '/home/u/site',
	inputDir: '/home/u/site/src',
	outputDir: '/home/u/site/htdocs',
};
const HOST = { Host: 'localhost' };
const WRITE = {
	...HOST,
	'Content-Type': 'application/json',
	[TOKEN_HEADER]: TOKEN,
};

let dir: string;
let file: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'kamado-ui-settings-'));
	file = path.join(dir, 'ui-settings.json');
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** An app that has a settings store over a file in the temporary directory. */
function setup() {
	const editor = {
		handle: 'h1',
		uiPages: () => '{}',
		uiRefresh: () => '{}',
		uiEdit: () => '{}',
	};
	const settings = createSettingsStore(file, KEY);
	const app = createUiApp(editor, { uiDir: dir, token: TOKEN, roots: ROOTS, settings });
	return { app, settings };
}

describe('GET /api/settings', () => {
	test('answers the defaults before anything is saved, and is not kept', async () => {
		const { app } = setup();
		const response = await app.request('/api/settings', { headers: HOST });
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(await response.json()).toEqual({
			global: { locale: 'auto' },
			project: null,
			warning: null,
		});
	});

	test('does not carry the path of the project, the others, or the settings file', async () => {
		const { app } = setup();
		await createSettingsStore(file, '/home/other/kamado.config.jsonc').update({
			project: { pageSize: 100 },
		});
		await createSettingsStore(file, KEY).update({ project: { pageSize: 1000 } });
		const response = await app.request('/api/settings', { headers: HOST });
		const text = await response.text();
		expect(JSON.parse(text).project.pageSize).toBe(1000);
		expect(text).not.toContain('/home/');
		expect(text).not.toContain(dir);
	});

	test('carries the warning of a file that was put aside, without the directory', async () => {
		const { app, settings } = setup();
		await writeFile(file, '{ not json');
		await settings.open();
		const response = await app.request('/api/settings', { headers: HOST });
		const body = (await response.json()) as {
			warning: string;
		};
		expect(body.warning).toMatch(/\.bak/);
		expect(body.warning).not.toContain(dir);
	});

	test('does not carry the path in the warning about a file that cannot be read at all', async () => {
		// The directory of the settings is a file: the disk's own message
		// ("ENOTDIR: not a directory, open '<path>'") names the path.
		await writeFile(path.join(dir, 'blocker'), '');
		const settings = createSettingsStore(
			path.join(dir, 'blocker', 'ui-settings.json'),
			KEY,
		);
		const app = createUiApp(
			{ handle: 'h1', uiPages: () => '{}', uiRefresh: () => '{}', uiEdit: () => '{}' },
			{ uiDir: dir, token: TOKEN, roots: ROOTS, settings },
		);
		const started = await settings.open();
		const response = await app.request('/api/settings', { headers: HOST });
		const text = await response.text();
		expect(started.warning).toMatch(/cannot be used: E[A-Z]+/);
		expect(started.warning).not.toContain(dir);
		expect(text).toMatch(/cannot be used: E[A-Z]+/);
		expect(text).not.toContain(dir);
	});

	test('is not a route when the app has no settings', async () => {
		const app = createUiApp(
			{ handle: 'h1', uiPages: () => '{}', uiRefresh: () => '{}', uiEdit: () => '{}' },
			{ uiDir: dir, token: TOKEN, roots: ROOTS },
		);
		const response = await app.request('/api/settings', { headers: HOST });
		expect(response.status).toBe(404);
	});
});

describe('PUT /api/settings', () => {
	/**
	 * Sends a body.
	 * @param app - The app
	 * @param body - The body
	 * @param headers - The headers
	 */
	function put(
		app: ReturnType<typeof setup>['app'],
		body: string,
		headers: Record<string, string> = WRITE,
	) {
		return app.request('/api/settings', { method: 'PUT', headers, body });
	}

	test('saves the page size and the language, and answers with the settings', async () => {
		const { app } = setup();
		const response = await put(
			app,
			JSON.stringify({ global: { locale: 'ja' }, project: { pageSize: 100 } }),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			global: { locale: string };
			project: { pageSize: number };
		};
		expect(body.global.locale).toBe('ja');
		expect(body.project.pageSize).toBe(100);
		const saved = JSON.parse(await readFile(file, 'utf8')) as {
			projects: Record<string, { pageSize: number }>;
		};
		expect(saved.projects[KEY]?.pageSize).toBe(100);
	});

	test('refuses a write without the token, and a body that is not JSON', async () => {
		const { app } = setup();
		const without = await put(app, '{}', { ...HOST, 'Content-Type': 'application/json' });
		expect(without.status).toBe(403);
		const wrongType = await put(app, '{}', { ...WRITE, 'Content-Type': 'text/plain' });
		expect(wrongType.status).toBe(415);
		const notJson = await put(app, '{');
		expect(notJson.status).toBe(400);
		await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
	});

	test('refuses a value that is not allowed, and writes nothing', async () => {
		const { app } = setup();
		const response = await put(app, JSON.stringify({ project: { pageSize: 7 } }));
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toBe('invalid');
		await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
	});

	test('refuses a body that is too large', async () => {
		const { app } = setup();
		const response = await put(app, JSON.stringify({ x: 'a'.repeat(70 * 1024) }));
		expect(response.status).toBe(413);
	});

	test('a file that stays locked by another kamado is a 503 without the path', async () => {
		const { app } = setup();
		await writeFile(`${file}.lock`, 'another kamado');
		const response = await put(app, JSON.stringify({ project: { pageSize: 100 } }));
		expect(response.status).toBe(503);
		const text = await response.text();
		expect(text).toContain('"error":"locked"');
		expect(text).not.toContain(dir);
		// The waiting is the real one (a few seconds), as the route cannot shorten it.
	}, 15_000);

	test('a disk that fails is a 500 with the error code, and without the path', async () => {
		// The directory of the settings is a file: the disk's own message names the path.
		await writeFile(path.join(dir, 'blocker'), '');
		const settings = createSettingsStore(
			path.join(dir, 'blocker', 'ui-settings.json'),
			KEY,
		);
		const app = createUiApp(
			{ handle: 'h1', uiPages: () => '{}', uiRefresh: () => '{}', uiEdit: () => '{}' },
			{ uiDir: dir, token: TOKEN, roots: ROOTS, settings },
		);
		const response = await put(app, JSON.stringify({ project: { pageSize: 100 } }));
		expect(response.status).toBe(500);
		const text = await response.text();
		expect(text).toMatch(/could not be saved \(E[A-Z]+\)/);
		expect(text).not.toContain(dir);
	});

	test('does not write a file of a newer version, and says so without the path', async () => {
		const { app } = setup();
		await writeFile(file, '{"version":2}');
		const response = await put(app, JSON.stringify({ project: { pageSize: 100 } }));
		expect(response.status).toBe(409);
		const text = await response.text();
		expect(text).toMatch(/newer/);
		expect(text).not.toContain(dir);
		expect(await readFile(file, 'utf8')).toBe('{"version":2}');
	});
});
