import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createUiApp, TOKEN_HEADER, TOKEN_PLACEHOLDER } from './app.js';

const TOKEN = 'a-token-for-the-test';
const ROOTS = {
	rootDir: '/home/u/site',
	inputDir: '/home/u/site/src',
	outputDir: '/home/u/site/htdocs',
};

const PAGE = {
	url: '/about/',
	inputPath: '/home/u/site/src/about/index.html',
	outputPath: '/home/u/site/htdocs/about/index.html',
	virtual: false,
	order: 1,
	depth: 1,
	parent: '/',
	hashes: { input: 'h', sidecar: null },
	meta: {},
};

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'kamado-ui-page-edits-'));
	await mkdir(path.join(dir, 'assets'));
	await writeFile(
		path.join(dir, 'index.html'),
		`<meta name="kamado-token" content="${TOKEN_PLACEHOLDER}">`,
	);
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/**
 * An app over a fake editor.
 * @param edit - What `uiEdit` answers
 */
function setup(
	edit: () => string = () =>
		JSON.stringify({ ok: true, version: 2, overridesHash: 'o2', page: PAGE }),
) {
	const editor = {
		handle: 'h1',
		uiPages: vi.fn<(handle: string, query: string) => string>(() =>
			JSON.stringify({
				version: 1,
				total: 1,
				columns: [],
				overridesHash: null,
				pages: [PAGE],
				warnings: [],
			}),
		),
		uiRefresh: vi.fn<(handle: string) => string>(() => '{"version":2}'),
		uiEdit: vi.fn<(handle: string, edit: string) => string>(edit),
		uiValues: vi.fn<(handle: string, query: string) => string>(() => '{}'),
	};
	const app = createUiApp(editor, { uiDir: dir, token: TOKEN, roots: ROOTS });
	return { app, editor };
}

const WRITE = {
	Host: 'localhost',
	'Content-Type': 'application/json',
	[TOKEN_HEADER]: TOKEN,
};

/**
 * Sends an edit.
 * @param app - The app
 * @param body - The request, as it is sent
 */
function post(app: ReturnType<typeof setup>['app'], body: unknown) {
	return app.request('/api/edit', {
		method: 'POST',
		headers: WRITE,
		body: JSON.stringify(body),
	});
}

describe('POST /api/edit: pages that are made, made virtual, given a file and removed', () => {
	test.each([
		{ url: '/new/', expect: {}, change: { op: 'create', path: 'new/index.html' } },
		{ url: '/v/', expect: { overrides: 'o' }, change: { op: 'create', path: null } },
		{
			url: '/about/',
			expect: { input: 'h', sidecar: null, overrides: 'o' },
			change: { op: 'virtualize' },
		},
		{
			url: '/v/',
			expect: { overrides: 'o' },
			change: { op: 'materialize', path: 'v/index.html' },
		},
		{ url: '/v/', expect: { overrides: 'o' }, change: { op: 'materialize', path: null } },
		{
			url: '/about/',
			expect: { input: 'h', sidecar: null },
			change: { op: 'deletePage' },
		},
	])('the request $change.op goes to the core as it is', async (request) => {
		const { app, editor } = setup();
		const response = await post(app, request);
		expect(response.status).toBe(200);
		expect(editor.uiEdit).toHaveBeenCalledWith('h1', JSON.stringify(request));
	});

	test('a page can be made without a URL when the request says the path of its file', async () => {
		const { app, editor } = setup();
		const request = { url: null, expect: {}, change: { op: 'create', path: 'a.html' } };
		const response = await post(app, request);
		expect(response.status).toBe(200);
		expect(editor.uiEdit).toHaveBeenCalledWith('h1', JSON.stringify(request));
		const body = (await response.json()) as { page: { inputPath: string } };
		// the paths of the page that was made are told from the directories, as for any edit
		expect(body.page.inputPath).toBe('about/index.html');
	});

	test('no other edit goes without the URL of its page', async () => {
		const { app, editor } = setup();
		for (const change of [
			{ op: 'virtualize' },
			{ op: 'deletePage' },
			{ op: 'materialize', path: 'a.html' },
			{ op: 'set', key: 'title', value: 'A' },
			{ op: 'movePath', path: 'a.html' },
		]) {
			const response = await post(app, { url: null, expect: {}, change });
			expect(response.status, change.op).toBe(400);
		}
		const noUrl = await post(app, {
			expect: {},
			change: { op: 'create', path: 'a.html' },
		});
		expect(noUrl.status).toBe(400);
		expect(editor.uiEdit).not.toHaveBeenCalled();
	});

	test('a page that is made with neither a URL nor a path is no request, and the core is not asked', async () => {
		const { app, editor } = setup();
		for (const change of [
			{ op: 'create', path: null },
			{ op: 'create' },
			{ op: 'create', path: 1 },
		]) {
			const response = await post(app, { url: null, expect: {}, change });
			expect(response.status, JSON.stringify(change)).toBe(400);
			expect(await response.json()).toMatchObject({ error: 'invalid' });
		}
		expect(editor.uiEdit).not.toHaveBeenCalled();
	});

	test('a core that throws at a request to make a page is a 500 without the directories', async () => {
		const { app } = setup(() => {
			throw new Error('edit: cannot read /home/u/site/kamado.config.jsonc');
		});
		const response = await post(app, {
			url: '/v/',
			expect: {},
			change: { op: 'create', path: 1 },
		});
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: 'failed',
			message: 'edit: cannot read <root>/kamado.config.jsonc',
		});
	});

	test('a page that was removed is answered as no page', async () => {
		const { app } = setup(() =>
			JSON.stringify({ ok: true, version: 3, overridesHash: 'o2', page: null }),
		);
		const response = await post(app, {
			url: '/about/',
			expect: { input: 'h', sidecar: null },
			change: { op: 'deletePage' },
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			version: 3,
			overridesHash: 'o2',
			page: null,
		});
	});

	test('what an edit that was made left undone is told without the directories of the machine', async () => {
		const { app } = setup(() =>
			JSON.stringify({
				ok: true,
				version: 3,
				overridesHash: null,
				page: null,
				warning:
					'the edit was made, but these files could not be removed and stay under another name: /home/u/site/src/.a.html.kamado-removed (Is a directory)',
			}),
		);
		const response = await post(app, {
			url: '/about/',
			expect: { input: 'h', sidecar: null },
			change: { op: 'deletePage' },
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as { warning: string };
		expect(body.warning).toContain('<input>/.a.html.kamado-removed (Is a directory)');
		expect(body.warning).not.toContain('/home/u');
	});

	test('a refusal of the core has the status of its code and no directory of the machine', async () => {
		const { app } = setup(() =>
			JSON.stringify({
				ok: false,
				code: 'collision',
				message: '/home/u/site/src/a.html already exists',
			}),
		);
		const response = await post(app, {
			url: null,
			expect: {},
			change: { op: 'create', path: 'a.html' },
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: 'collision',
			message: '<input>/a.html already exists',
		});
	});
});

describe('GET /api/pages: the columns every row has are sorts', () => {
	test.each(['order', 'outputPath', 'parent', 'depth'])(
		'%s is passed to the core',
		async (key) => {
			const { app, editor } = setup();
			const response = await app.request(`/api/pages?sort=${key}&desc=true`, {
				headers: { Host: 'localhost' },
			});
			expect(response.status).toBe(200);
			expect(JSON.parse(editor.uiPages.mock.calls[0]?.[1] ?? '{}')).toMatchObject({
				sort: { key, desc: true },
			});
		},
	);

	test('a name that is no column is refused, and the answer names the ones there are', async () => {
		const { app, editor } = setup();
		const response = await app.request('/api/pages?sort=hashes', {
			headers: { Host: 'localhost' },
		});
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string; message: string };
		expect(body.error).toBe('invalidSort');
		expect(body.message).toContain('order, outputPath, parent, depth');
		expect(editor.uiPages).not.toHaveBeenCalled();
	});
});
