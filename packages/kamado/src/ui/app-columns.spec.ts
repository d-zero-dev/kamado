import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
const WRITE = {
	Host: 'localhost',
	'Content-Type': 'application/json',
	[TOKEN_HEADER]: TOKEN,
};

let dir: string;
let file: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'kamado-ui-columns-app-'));
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
	return createUiApp(editor, { uiDir: dir, token: TOKEN, roots: ROOTS, settings });
}

describe('the columns through /api/settings', () => {
	const columns = {
		order: ['url', 'meta:title', 'virtual'],
		pinned: ['url', 'meta:title'],
		widths: { url: 300 },
	};

	test('are saved, and come back with the settings of the project', async () => {
		const app = setup();
		const saved = await app.request('/api/settings', {
			method: 'PUT',
			headers: WRITE,
			body: JSON.stringify({ project: { columns } }),
		});
		expect(saved.status).toBe(200);
		expect(
			((await saved.json()) as { project: { columns: unknown } }).project.columns,
		).toEqual(columns);
		const read = await app.request('/api/settings', { headers: { Host: 'localhost' } });
		expect(
			((await read.json()) as { project: { columns: unknown } }).project.columns,
		).toEqual(columns);
		const written = JSON.parse(await readFile(file, 'utf8')) as {
			projects: Record<string, { columns: unknown }>;
		};
		expect(written.projects[KEY]?.columns).toEqual(columns);
	});

	test('are refused when a list names something that is not a column, and nothing is written', async () => {
		const app = setup();
		const response = await app.request('/api/settings', {
			method: 'PUT',
			headers: WRITE,
			body: JSON.stringify({ project: { columns: { pinned: ['title'] } } }),
		});
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toBe('invalid');
		await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
	});

	test('as many as the limit allows, with ordinary key names, fit in the body of a change', async () => {
		const app = setup();
		const ids = Array.from(
			{ length: 500 },
			(_, n) => `meta:keyname${String(n).padStart(4, '0')}`,
		);
		const response = await app.request('/api/settings', {
			method: 'PUT',
			headers: WRITE,
			body: JSON.stringify({
				project: {
					columns: {
						order: ids,
						pinned: ids,
						widths: Object.fromEntries(ids.map((id) => [id, 100])),
					},
				},
			}),
		});
		expect(response.status).toBe(200);
	});

	test('a change that is only the columns leaves the sort and the page size as they were', async () => {
		const app = setup();
		await app.request('/api/settings', {
			method: 'PUT',
			headers: WRITE,
			body: JSON.stringify({
				project: { pageSize: 100, sort: { key: 'url', desc: true } },
			}),
		});
		const response = await app.request('/api/settings', {
			method: 'PUT',
			headers: WRITE,
			body: JSON.stringify({ project: { columns } }),
		});
		const body = (await response.json()) as {
			project: { pageSize: number; sort: unknown };
		};
		expect(body.project.pageSize).toBe(100);
		expect(body.project.sort).toEqual({ key: 'url', desc: true });
	});

	test('are refused when a width is out of range', async () => {
		const app = setup();
		const response = await app.request('/api/settings', {
			method: 'PUT',
			headers: WRITE,
			body: JSON.stringify({ project: { columns: { widths: { url: 5 } } } }),
		});
		expect(response.status).toBe(400);
	});
});
