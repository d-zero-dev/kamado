import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createUiApp, MAX_ROWS, TOKEN_HEADER, TOKEN_PLACEHOLDER } from './app.js';

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
	depth: 1,
	parent: '/',
	hashes: { input: 'h', sidecar: null },
	meta: {},
};

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'kamado-ui-'));
	await mkdir(path.join(dir, 'assets'));
	await writeFile(
		path.join(dir, 'index.html'),
		`<meta name="kamado-token" content="${TOKEN_PLACEHOLDER}">`,
	);
	await writeFile(path.join(dir, 'assets', 'app.js'), 'export {};');
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
		JSON.stringify({ ok: true, version: 2, overridesHash: null, page: PAGE }),
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
				warnings: ['see /home/u/site/src/x.html'],
			}),
		),
		uiRefresh: vi.fn<(handle: string) => string>(() => '{"version":2}'),
		uiEdit: vi.fn<(handle: string, edit: string) => string>(edit),
	};
	const app = createUiApp(editor, { uiDir: dir, token: TOKEN, roots: ROOTS });
	return { app, editor };
}

const HOST = { Host: 'localhost' };
const WRITE = {
	...HOST,
	'Content-Type': 'application/json',
	[TOKEN_HEADER]: TOKEN,
};
const EDIT = JSON.stringify({
	url: '/about/',
	expect: { input: 'h', sidecar: null, overrides: null },
	change: { op: 'set', key: 'title', value: 'A' },
});

describe('the page and the assets', () => {
	test('an asset is asked about each time, and answers 304 to a request that has its ETag', async () => {
		const { app } = setup();
		const first = await app.request('/assets/app.js', { headers: HOST });
		expect(first.headers.get('cache-control')).toBe('no-cache');
		const tag = first.headers.get('etag');
		expect(tag).not.toBeNull();
		const again = await app.request('/assets/app.js', {
			headers: { ...HOST, 'If-None-Match': tag ?? '' },
		});
		expect(again.status).toBe(304);
	});
	test('the page carries the token and is not kept', async () => {
		const { app } = setup();
		const response = await app.request('/', { headers: HOST });
		expect(response.status).toBe(200);
		expect(await response.text()).toContain(`content="${TOKEN}"`);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('referrer-policy')).toBe('no-referrer');
		expect(response.headers.get('content-security-policy')).toContain(
			"default-src 'self'",
		);
	});
	test('an asset is served, one that is not there is not', async () => {
		const { app } = setup();
		const there = await app.request('/assets/app.js', { headers: HOST });
		const missing = await app.request('/assets/none.js', { headers: HOST });
		expect(there.status).toBe(200);
		expect(missing.status).toBe(404);
	});
	test('a name with a way up is not an asset', async () => {
		const { app } = setup();
		const response = await app.request(
			'/assets/..%2f..%2f..%2f..%2f..%2f..%2f..%2f..%2f',
			{ headers: HOST },
		);
		expect(response.status).toBe(404);
	});
});

describe('the guard', () => {
	test('a host that is not the loopback is refused', async () => {
		const { app } = setup();
		const response = await app.request('http://evil.example/api/pages');
		expect(response.status).toBe(403);
	});
	test('a request from another site is refused', async () => {
		const { app } = setup();
		const response = await app.request('/api/pages', {
			headers: {
				...HOST,
				'Sec-Fetch-Site': 'cross-site',
				Origin: 'https://evil.example',
			},
		});
		expect(response.status).toBe(403);
	});
});

describe('GET /api/pages', () => {
	test('passes the window to the editor and tells the paths from the directories', async () => {
		const { app, editor } = setup();
		const response = await app.request('/api/pages?offset=5&limit=10&q=ab', {
			headers: HOST,
		});
		expect(response.status).toBe(200);
		expect(JSON.parse(editor.uiPages.mock.calls[0]?.[1] ?? '')).toEqual({
			offset: 5,
			limit: 10,
			q: 'ab',
		});
		const body = (await response.json()) as {
			pages: { inputPath: string; outputPath: string }[];
			warnings: string[];
		};
		expect(body.pages[0]?.inputPath).toBe('about/index.html');
		expect(body.pages[0]?.outputPath).toBe('about/index.html');
		expect(body.warnings).toEqual(['see <input>/x.html']);
		expect(JSON.stringify(body)).not.toContain('/home/u');
	});
	test.each([['offset=-1'], ['offset=abc'], ['limit=0'], [`limit=${MAX_ROWS + 1}`]])(
		'%s is refused',
		async (query) => {
			const { app, editor } = setup();
			const response = await app.request(`/api/pages?${query}`, { headers: HOST });
			expect(response.status).toBe(400);
			expect(editor.uiPages).not.toHaveBeenCalled();
		},
	);
	test('an error of the core is a 500 without the directories', async () => {
		const { app, editor } = setup();
		editor.uiPages.mockImplementation(() => {
			throw new Error('cannot read /home/u/site/pages.json');
		});
		const response = await app.request('/api/pages', { headers: HOST });
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: 'failed',
			message: 'cannot read <root>/pages.json',
		});
	});
});

describe('the writes need the token', () => {
	test.each([
		['without it', { ...HOST, 'Content-Type': 'application/json' }],
		[
			'with another',
			{ ...HOST, 'Content-Type': 'application/json', [TOKEN_HEADER]: 'nope' },
		],
		[
			'marked cross-site, with the token',
			{ ...WRITE, 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' },
		],
	])('an edit %s is refused', async (_name, headers) => {
		const { app, editor } = setup();
		const response = await app.request('/api/edit', {
			method: 'POST',
			headers,
			body: EDIT,
		});
		expect(response.status).toBe(403);
		expect(editor.uiEdit).not.toHaveBeenCalled();
	});
	test('a refresh without it is refused', async () => {
		const { app, editor } = setup();
		const response = await app.request('/api/refresh', { method: 'POST', headers: HOST });
		expect(response.status).toBe(403);
		expect(editor.uiRefresh).not.toHaveBeenCalled();
	});
	test('a body that is not JSON by its type is refused', async () => {
		const { app, editor } = setup();
		const response = await app.request('/api/edit', {
			method: 'POST',
			headers: { ...WRITE, 'Content-Type': 'text/plain' },
			body: EDIT,
		});
		expect(response.status).toBe(415);
		expect(editor.uiEdit).not.toHaveBeenCalled();
	});
});

describe('POST /api/edit', () => {
	test('passes the request on and answers with the page', async () => {
		const { app, editor } = setup();
		const response = await app.request('/api/edit', {
			method: 'POST',
			headers: WRITE,
			body: EDIT,
		});
		expect(response.status).toBe(200);
		expect(editor.uiEdit).toHaveBeenCalledWith('h1', EDIT);
		const body = (await response.json()) as { ok: boolean; page: { inputPath: string } };
		expect(body.ok).toBe(true);
		expect(body.page.inputPath).toBe('about/index.html');
	});
	test.each([
		['conflict', 409],
		['collision', 409],
		['invalid', 400],
		['notEditable', 400],
		['notFound', 404],
		['io', 500],
	])('a %s of the core is a %i', async (code, status) => {
		const { app } = setup(() =>
			JSON.stringify({
				ok: false,
				code,
				message: 'at /home/u/site/src/a.html',
				current: PAGE,
			}),
		);
		const response = await app.request('/api/edit', {
			method: 'POST',
			headers: WRITE,
			body: EDIT,
		});
		expect(response.status).toBe(status);
		const body = (await response.json()) as {
			error: string;
			message: string;
			current: { inputPath: string };
		};
		expect(body.error).toBe(code);
		expect(body.message).toBe('at <input>/a.html');
		expect(body.current.inputPath).toBe('about/index.html');
	});
	test.each([
		['is not JSON', '{'],
		['is an array', '[]'],
		['has no expect and change', '{"url":"/a/"}'],
		['has a url that is not a string', '{"url":1,"expect":{},"change":{}}'],
		['has an expect that is an array', '{"url":"/a/","expect":[],"change":{}}'],
		['has a change that is an array', '{"url":"/a/","expect":{},"change":[]}'],
	])('a body that %s is refused before the core sees it', async (_name, body) => {
		const { app, editor } = setup();
		const response = await app.request('/api/edit', {
			method: 'POST',
			headers: WRITE,
			body,
		});
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toBe('invalid');
		expect(editor.uiEdit).not.toHaveBeenCalled();
	});
	test('a content type with a charset is JSON', async () => {
		const { app, editor } = setup();
		const response = await app.request('/api/edit', {
			method: 'POST',
			headers: { ...WRITE, 'Content-Type': 'application/json; charset=utf-8' },
			body: EDIT,
		});
		expect(response.status).toBe(200);
		expect(editor.uiEdit).toHaveBeenCalledTimes(1);
	});
	test('a core that throws is a 500 without the directories, and nothing is said of a page', async () => {
		const { app } = setup(() => {
			throw new Error('no editor for handle h1 at /home/u/site/src');
		});
		const response = await app.request('/api/edit', {
			method: 'POST',
			headers: WRITE,
			body: EDIT,
		});
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: 'failed',
			message: 'no editor for handle h1 at <input>',
		});
	});
	test.each(['PUT', 'DELETE', 'PATCH'])(
		'a %s needs the token as a POST does',
		async (method) => {
			const { app } = setup();
			const response = await app.request('/api/edit', {
				method,
				headers: { ...HOST, 'Content-Type': 'application/json' },
				body: EDIT,
			});
			expect(response.status).toBe(403);
		},
	);
	test('a body that is too large is refused', async () => {
		const { app, editor } = setup();
		const response = await app.request('/api/edit', {
			method: 'POST',
			headers: WRITE,
			body: JSON.stringify({ pad: 'x'.repeat(1024 * 1024 + 1) }),
		});
		expect(response.status).toBe(413);
		expect(editor.uiEdit).not.toHaveBeenCalled();
	});
});

describe('POST /api/refresh', () => {
	test('has the core read the site again', async () => {
		const { app, editor } = setup();
		const response = await app.request('/api/refresh', {
			method: 'POST',
			headers: WRITE,
			body: '{}',
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ version: 2 });
		expect(editor.uiRefresh).toHaveBeenCalledWith('h1');
	});
	test('a core that cannot read the site again is a 500 without the directories', async () => {
		const { app, editor } = setup();
		editor.uiRefresh.mockImplementation(() => {
			throw new Error('cannot read pages.overrides /home/u/site/p.json');
		});
		const response = await app.request('/api/refresh', {
			method: 'POST',
			headers: WRITE,
			body: '{}',
		});
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: 'failed',
			message: 'cannot read pages.overrides <root>/p.json',
		});
	});
});

describe('what is answered', () => {
	test('a window without a search or a limit is the first hundred, and an empty search is none', async () => {
		const { app, editor } = setup();
		await app.request('/api/pages?q=', { headers: HOST });
		expect(JSON.parse(editor.uiPages.mock.calls[0]?.[1] ?? '')).toEqual({
			offset: 0,
			limit: 100,
		});
	});
	test('every answer is kept out of caches, and says what it is', async () => {
		const { app } = setup();
		const response = await app.request('/api/pages', { headers: HOST });
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
		expect(response.headers.get('referrer-policy')).toBe('no-referrer');
	});
	test('a route that is not one is a 404 in JSON', async () => {
		const { app } = setup();
		const response = await app.request('/api/nothing', { headers: HOST });
		expect(response.status).toBe(404);
		expect(((await response.json()) as { error: string }).error).toBe('not-found');
	});
	test('a screen that was not built is said, and a HEAD needs no token', async () => {
		await rm(path.join(dir, 'index.html'));
		const { app } = setup();
		const response = await app.request('/', { headers: HOST });
		expect(response.status).toBe(500);
		expect(await response.text()).toContain('not built');
		const head = await app.request('/api/pages', { method: 'HEAD', headers: HOST });
		expect(head.status).toBe(200);
	});
	test('a file outside the assets, a directory and a hidden file are not assets', async () => {
		const outside = 'secret.txt';
		await writeFile(path.join(dir, outside), 'secret');
		await mkdir(path.join(dir, 'assets', 'sub'));
		await writeFile(path.join(dir, 'assets', '.hidden'), 'x');
		const { app } = setup();
		// The first name goes up out of `assets` to the file written above.
		for (const name of [`..%2f${outside}`, 'sub', '.hidden']) {
			const response = await app.request(`/assets/${name}`, { headers: HOST });
			expect(response.status).toBe(404);
			expect(await response.text()).not.toContain('secret');
		}
	});
});

describe('what the screen and the server agree on', () => {
	const client = path.resolve(import.meta.dirname, '..', '..', 'client');

	test('the page of the screen has the place of the token, and the screen reads it where it is', async () => {
		const html = await readFile(path.join(client, 'index.html'), 'utf8');
		expect(html).toContain(`<meta name="kamado-token" content="${TOKEN_PLACEHOLDER}"`);
		const api = await readFile(path.join(client, 'src', 'api.ts'), 'utf8');
		expect(api).toContain('meta[name="kamado-token"]');
	});
	test('the screen sends the token in the header the server reads', async () => {
		const api = await readFile(path.join(client, 'src', 'api.ts'), 'utf8');
		// Behavior change: the screen also sends the token to read the difference from HEAD and to put a value back
		expect(api.match(new RegExp(`'${TOKEN_HEADER}'`, 'g'))?.length).toBe(5);
		// Behavior change: the screen also sends the token when it saves its settings
		// expect(api.match(new RegExp(`'${TOKEN_HEADER}'`, 'g'))?.length).toBe(3); // previous
		// expect(api.match(new RegExp(`'${TOKEN_HEADER}'`, 'g'))?.length).toBe(2); // previous
	});
});
