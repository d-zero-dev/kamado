import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createUiApp, TOKEN_PLACEHOLDER } from './app.js';
import { isColumnId, isSortKey, parsePatch, parseSettings } from './settings.js';

const TOKEN = 'a-token-for-the-test';
const ROOTS = {
	rootDir: '/home/u/site',
	inputDir: '/home/u/site/src',
	outputDir: '/home/u/site/htdocs',
};

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'kamado-ui-order-'));
	await mkdir(path.join(dir, 'assets'));
	await writeFile(
		path.join(dir, 'index.html'),
		`<meta name="kamado-token" content="${TOKEN_PLACEHOLDER}">`,
	);
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** An app over a fake editor that lists no page. */
function setup() {
	const editor = {
		handle: 'h1',
		uiPages: vi.fn<(handle: string, query: string) => string>(() =>
			JSON.stringify({
				version: 1,
				offset: 0,
				total: 0,
				columns: ['order'],
				overridesHash: null,
				pages: [],
				warnings: [],
			}),
		),
		uiRefresh: vi.fn<(handle: string) => string>(() => '{"version":2}'),
		uiEdit: vi.fn<(handle: string, edit: string) => string>(() => '{}'),
		uiValues: vi.fn<(handle: string, query: string) => string>(() => '{}'),
	};
	const app = createUiApp(editor, { uiDir: dir, token: TOKEN, roots: ROOTS });
	return { app, editor };
}

const READ = { Host: 'localhost' };

describe('the key that places a page (order)', () => {
	test.each(['order', 'meta:order'])('%s is not a sort', async (key) => {
		const { app, editor } = setup();
		const response = await app.request(`/api/pages?sort=${key}`, { headers: READ });
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string };
		expect(body.error).toBe('invalidSort');
		expect(editor.uiPages).not.toHaveBeenCalled();
	});

	test('the page that is to be found is passed to the core, and an empty one is not', async () => {
		const { app, editor } = setup();
		const found = await app.request('/api/pages?locate=%2Fabout%2F&limit=100', {
			headers: READ,
		});
		expect(found.status).toBe(200);
		expect(JSON.parse(editor.uiPages.mock.calls[0]?.[1] ?? '{}')).toMatchObject({
			locate: '/about/',
			limit: 100,
		});
		const none = await app.request('/api/pages?locate=&limit=100', { headers: READ });
		expect(none.status).toBe(200);
		expect(JSON.parse(editor.uiPages.mock.calls[1]?.[1] ?? '{}')).not.toHaveProperty(
			'locate',
		);
	});
});

describe('the identifiers of the columns', () => {
	test('meta:order is a column of the layout and not a sort', () => {
		expect(isColumnId('meta:order')).toBe(true);
		expect(isSortKey('meta:order')).toBe(false);
		expect(isSortKey('meta:title')).toBe(true);
	});

	test('the number of the place in the plan is no column any more', () => {
		expect(isColumnId('order')).toBe(false);
		expect(isSortKey('order')).toBe(false);
	});

	test('a layout may name meta:order, and a sort by it is refused', () => {
		expect(
			parsePatch({
				project: { columns: { pinned: ['meta:order'], widths: { 'meta:order': 120 } } },
			}).project,
		).toEqual({ columns: { pinned: ['meta:order'], widths: { 'meta:order': 120 } } });
		expect(() =>
			parsePatch({ project: { sort: { key: 'meta:order', desc: false } } }),
		).toThrow();
	});
});

describe('a settings file of before the number of the place was no column', () => {
	const KEY = '/home/u/site/kamado.config.jsonc';

	test('is read without the identifiers that are no column any more, and keeps the others', () => {
		const read = parseSettings(
			JSON.stringify({
				version: 1,
				global: { locale: 'auto' },
				projects: {
					[KEY]: {
						updatedAt: '2026-01-02T03:04:05.000Z',
						pageSize: 500,
						sort: { key: 'order', desc: false },
						columns: {
							order: ['url', 'order', 'meta:order', 'depth'],
							pinned: ['order', 'url'],
							widths: { order: 100, depth: 120, 'meta:order': 200 },
						},
					},
				},
			}),
		);
		expect(read.state).toBe('ok');
		const project = read.state === 'ok' ? read.settings.projects[KEY] : undefined;
		expect(project).not.toHaveProperty('sort');
		expect(project?.columns).toEqual({
			order: ['url', 'meta:order', 'depth'],
			pinned: ['url'],
			widths: { depth: 120, 'meta:order': 200 },
		});
	});

	test('is refused when the screen asks to save one of them', () => {
		for (const id of ['order']) {
			expect(() => parsePatch({ project: { columns: { pinned: [id] } } })).toThrow();
			expect(() => parsePatch({ project: { sort: { key: id } } })).toThrow();
		}
	});
});
