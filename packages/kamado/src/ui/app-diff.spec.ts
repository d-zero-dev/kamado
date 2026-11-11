import type { DiffAnswer, HeadDiff, RevertResult } from './head-diff.js';

import { describe, expect, test } from 'vitest';

import { createUiApp, MAX_ROWS, TOKEN_HEADER } from './app.js';

const ROOTS = {
	rootDir: '/home/u/site',
	inputDir: '/home/u/site/src',
	outputDir: '/home/u/site/htdocs',
};
const HEAD_OID = 'a'.repeat(40);
const HOST = { Host: 'localhost' };
const WRITE = {
	...HOST,
	'Content-Type': 'application/json',
	[TOKEN_HEADER]: 't',
};

/**
 * An app with a fake `HEAD`, and the calls its editor receives.
 * @param head - The difference from HEAD, or none
 * @param pagesAnswer - What the core says to `uiPages`
 */
function setup(head?: HeadDiff, pagesAnswer = '{"pages":[],"warnings":[]}') {
	const edits: unknown[] = [];
	const editor = {
		handle: 'h1',
		uiPages: () => pagesAnswer,
		uiRefresh: () => '{}',
		uiValues: () => '{}',
		uiEdit: (_handle: string, edit: string) => {
			edits.push(JSON.parse(edit));
			return '{"ok":true}';
		},
	};
	const app = createUiApp(editor, {
		uiDir: '/nowhere',
		token: 't',
		roots: ROOTS,
		head,
		overridesFile: 'data/pages.overrides.json',
	});
	return { app, edits };
}

const answer: DiffAnswer = {
	head: { oid: HEAD_OID },
	version: 3,
	pages: {
		'/a/': { meta: { title: { kind: 'modified', head: 'Old', revertible: true } } },
	},
	columns: [],
};

describe('POST /api/diff', () => {
	test('passes the URLs to the difference from HEAD and its answer on', async () => {
		const asked: (readonly string[])[] = [];
		const { app } = setup({
			diff: (urls) => {
				asked.push(urls);
				return Promise.resolve(answer);
			},
			revert: () => Promise.resolve({ kind: 'noHead' }),
		});
		const response = await app.request('/api/diff', {
			method: 'POST',
			headers: WRITE,
			body: JSON.stringify({ urls: ['/a/', '/b/'] }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(answer);
		expect(asked).toEqual([['/a/', '/b/']]);
	});

	test('answers null when there is nothing to compare with', async () => {
		const { app } = setup({
			diff: () => Promise.resolve(null),
			revert: () => Promise.resolve({ kind: 'noHead' }),
		});
		const response = await app.request('/api/diff', {
			method: 'POST',
			headers: WRITE,
			body: JSON.stringify({ urls: ['/a/'] }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toBeNull();
		const without = await setup().app.request('/api/diff', {
			method: 'POST',
			headers: WRITE,
			body: JSON.stringify({ urls: ['/a/'] }),
		});
		expect(without.status).toBe(200);
		expect(await without.json()).toBeNull();
	});

	test('refuses a request without the token, and a body that is not { urls }', async () => {
		const { app } = setup({
			diff: () => Promise.resolve(answer),
			revert: () => Promise.resolve({ kind: 'noHead' }),
		});
		const noToken = await app.request('/api/diff', {
			method: 'POST',
			headers: { ...HOST, 'Content-Type': 'application/json' },
			body: JSON.stringify({ urls: ['/a/'] }),
		});
		expect(noToken.status).toBe(403);
		for (const body of [
			'not json',
			'null',
			'[]',
			JSON.stringify({}),
			JSON.stringify({ urls: [] }),
			JSON.stringify({ urls: 'a' }),
			JSON.stringify({ urls: [1] }),
			JSON.stringify({ urls: ['/a/'.padEnd(5000, 'a')] }),
			JSON.stringify({ urls: Array.from({ length: MAX_ROWS + 1 }, () => '/a/') }),
		]) {
			const response = await app.request('/api/diff', {
				method: 'POST',
				headers: WRITE,
				body,
			});
			expect(response.status, body.slice(0, 30)).toBe(400);
		}
	});

	test('takes as many URLs as a window has', async () => {
		const { app } = setup({
			diff: () => Promise.resolve(answer),
			revert: () => Promise.resolve({ kind: 'noHead' }),
		});
		const response = await app.request('/api/diff', {
			method: 'POST',
			headers: WRITE,
			body: JSON.stringify({
				urls: Array.from({ length: MAX_ROWS }, (_, i) => `/p${i}/`),
			}),
		});
		expect(response.status).toBe(200);
	});

	test('is a failure of the editor, without the directories of the machine, when it throws', async () => {
		const { app } = setup({
			diff: () => Promise.reject(new Error('cannot read /home/u/site/src/a.html')),
			revert: () => Promise.resolve({ kind: 'noHead' }),
		});
		const response = await app.request('/api/diff', {
			method: 'POST',
			headers: WRITE,
			body: JSON.stringify({ urls: ['/a/'] }),
		});
		expect(response.status).toBe(500);
		const body = (await response.json()) as { error: string; message: string };
		expect(body.error).toBe('failed');
		expect(body.message).toContain('<input>');
		expect(body.message).not.toContain('/home/u');
	});
});

describe('POST /api/revert', () => {
	const request = {
		url: '/a/',
		expect: { input: 'h', sidecar: null, overrides: null },
		key: 'title',
		head: HEAD_OID,
	};

	/**
	 * Posts a revert.
	 * @param app - The app
	 * @param body - The body
	 */
	function post(app: ReturnType<typeof setup>['app'], body: unknown) {
		return app.request('/api/revert', {
			method: 'POST',
			headers: WRITE,
			body: JSON.stringify(body),
		});
	}

	test('passes the request on and the page the core made back, with its paths told from the directories', async () => {
		const asked: unknown[] = [];
		const result = {
			ok: true,
			version: 5,
			page: {
				url: '/a/',
				inputPath: '/home/u/site/src/a/index.html',
				outputPath: '/home/u/site/htdocs/a/index.html',
			},
		};
		const { app } = setup({
			diff: () => Promise.resolve(answer),
			revert: (r) => {
				asked.push(r);
				return Promise.resolve({ kind: 'edit', result } satisfies RevertResult);
			},
		});
		const response = await post(app, request);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { page: { inputPath: string } };
		expect(body.page.inputPath).toBe('a/index.html');
		expect(asked).toEqual([request]);
		// the url column has no key
		await post(app, { ...request, key: null });
		expect(asked[1]).toEqual({ ...request, key: null });
	});

	test('answers with the status of the reason the core gave', async () => {
		const cases: [unknown, number][] = [
			[{ ok: false, code: 'conflict', message: 'x' }, 409],
			[{ ok: false, code: 'notEditable', message: 'x' }, 400],
			[{ ok: false, code: 'notFound', message: 'x' }, 404],
			[{ ok: false, code: 'io', message: 'x' }, 500],
		];
		for (const [result, status] of cases) {
			const { app } = setup({
				diff: () => Promise.resolve(answer),
				revert: () => Promise.resolve({ kind: 'edit', result }),
			});
			const response = await post(app, request);
			expect(response.status).toBe(status);
		}
	});

	test('does not write when the commit is gone or has moved', async () => {
		for (const kind of ['noHead', 'headMoved'] as const) {
			const { app } = setup({
				diff: () => Promise.resolve(answer),
				revert: () => Promise.resolve({ kind }),
			});
			const response = await post(app, request);
			expect(response.status).toBe(409);
			expect(((await response.json()) as { error: string }).error).toBe(kind);
		}
		// no `HEAD` at all is no commit
		const none = await post(setup().app, request);
		expect(none.status).toBe(409);
		expect(((await none.json()) as { error: string }).error).toBe('noHead');
	});

	test('refuses a request without the token, and a body that is not { url, expect, key, head }', async () => {
		const { app } = setup({
			diff: () => Promise.resolve(answer),
			revert: () => Promise.resolve({ kind: 'edit', result: { ok: true } }),
		});
		const noToken = await app.request('/api/revert', {
			method: 'POST',
			headers: { ...HOST, 'Content-Type': 'application/json' },
			body: JSON.stringify(request),
		});
		expect(noToken.status).toBe(403);
		for (const body of [
			{ ...request, url: 5 },
			{ ...request, expect: null },
			{ ...request, expect: [] },
			{ ...request, key: 5 },
			{ ...request, key: '' },
			{ ...request, key: 'k'.repeat(257) },
			{ ...request, head: 'HEAD' },
			{ ...request, head: '--help' },
			{ ...request, head: undefined },
			null,
			[],
		]) {
			const response = await post(app, body);
			expect(response.status, JSON.stringify(body)).toBe(400);
		}
		const notJson = await app.request('/api/revert', {
			method: 'POST',
			headers: WRITE,
			body: 'not json',
		});
		expect(notJson.status).toBe(400);
	});
});

describe('POST /api/edit', () => {
	test('does not take a revert: what HEAD held is read from git, not from a request', async () => {
		const { app, edits } = setup();
		const response = await app.request('/api/edit', {
			method: 'POST',
			headers: WRITE,
			body: JSON.stringify({
				url: '/a/',
				expect: {},
				change: {
					op: 'revert',
					key: 'title',
					head: { 'src/a.html': { oid: 'x', text: 'y' } },
				},
			}),
		});
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toBe('invalid');
		expect(edits).toEqual([]);
	});

	test('still takes the edits it did', async () => {
		const { app, edits } = setup();
		const response = await app.request('/api/edit', {
			method: 'POST',
			headers: WRITE,
			body: JSON.stringify({
				url: '/a/',
				expect: {},
				change: { op: 'delete', key: 'title' },
			}),
		});
		expect(response.status).toBe(200);
		expect(edits).toHaveLength(1);
	});
});

describe('GET /api/pages', () => {
	test('names the pages.overrides file, relative to the config directory', async () => {
		const { app } = setup();
		const response = await app.request('/api/pages', { headers: HOST });
		expect(((await response.json()) as { overridesFile: string }).overridesFile).toBe(
			'data/pages.overrides.json',
		);
	});

	test('says null when the site has none', async () => {
		const app = createUiApp(
			{
				handle: 'h1',
				uiPages: () => '{"pages":[],"warnings":[]}',
				uiRefresh: () => '{}',
				uiValues: () => '{}',
				uiEdit: () => '{}',
			},
			{ uiDir: '/nowhere', token: 't', roots: ROOTS },
		);
		const response = await app.request('/api/pages', { headers: HOST });
		expect(((await response.json()) as { overridesFile: null }).overridesFile).toBeNull();
	});
});
