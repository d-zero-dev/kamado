import type { SyncController } from '../sync/controller.js';

import { describe, expect, test, vi } from 'vitest';

import { createUiApp, TOKEN_HEADER } from './app.js';

const TOKEN = 'a-token-for-the-test';
const ROOTS = {
	rootDir: '/home/u/site',
	inputDir: '/home/u/site/src',
	outputDir: '/home/u/site/htdocs',
};

/**
 *
 * @param over
 */
function fakeSync(over: Partial<SyncController> = {}): SyncController {
	return {
		functions: vi.fn(() => [{ name: 'import', label: { en: 'Import' } }]),
		run: vi.fn(() => ({ ok: true as const, id: 'id-1' })),
		state: vi.fn(() => ({
			id: 'id-1',
			name: 'import',
			status: 'running' as const,
			log: [],
			next: 0,
			dropped: 0,
		})),
		changes: vi.fn(() => ({ total: 0, changes: [] })),
		apply: vi.fn(() => ({ ok: true as const })),
		cancel: vi.fn(() => true),
		close: vi.fn(),
		...over,
	};
}

/**
 *
 * @param sync
 */
function setup(sync?: SyncController) {
	const editor = {
		handle: 'h1',
		uiPages: () => '{}',
		uiRefresh: () => '{}',
		uiEdit: () => '{}',
		uiValues: () => '{}',
	};
	return createUiApp(editor, {
		uiDir: '/nowhere',
		token: TOKEN,
		roots: ROOTS,
		...(sync === undefined ? {} : { sync }),
	});
}

const GET = { headers: { Host: 'localhost' } };

/**
 *
 * @param body
 * @param over
 */
function post(body: unknown, over: Record<string, string> = {}) {
	return {
		method: 'POST',
		headers: {
			Host: 'localhost',
			'Content-Type': 'application/json',
			[TOKEN_HEADER]: TOKEN,
			...over,
		},
		body: typeof body === 'string' ? body : JSON.stringify(body),
	};
}

describe('without a sync', () => {
	test.each([
		['GET', '/api/sync'],
		['GET', '/api/sync/state?id=x'],
		['POST', '/api/sync/run'],
	])('%s %s does not exist', async (method, url) => {
		const response = await setup().request(
			url,
			method === 'GET' ? GET : post({ name: 'x' }),
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ error: 'not-found' });
	});
});

describe('GET /api/sync', () => {
	test('tells the operations: name and label, as written', async () => {
		const response = await setup(fakeSync()).request('/api/sync', GET);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			functions: [{ name: 'import', label: { en: 'Import' } }],
		});
	});

	test('tells no operation when there is none', async () => {
		const response = await setup(fakeSync({ functions: () => [] })).request(
			'/api/sync',
			GET,
		);
		expect(await response.json()).toEqual({ functions: [] });
	});
});

describe('the guards of a write cover the sync', () => {
	test.each(['/api/sync/run', '/api/sync/apply', '/api/sync/cancel'])(
		'%s needs the token',
		async (url) => {
			const sync = fakeSync();
			const without = await setup(sync).request(url, {
				method: 'POST',
				headers: { Host: 'localhost', 'Content-Type': 'application/json' },
				body: '{"name":"import","id":"id-1"}',
			});
			expect(without.status).toBe(403);
			const wrong = await setup(sync).request(
				url,
				post({ name: 'import', id: 'id-1' }, { [TOKEN_HEADER]: 'another' }),
			);
			expect(wrong.status).toBe(403);
			expect(sync.run).not.toHaveBeenCalled();
			expect(sync.apply).not.toHaveBeenCalled();
			expect(sync.cancel).not.toHaveBeenCalled();
		},
	);

	test.each(['/api/sync/run', '/api/sync/apply', '/api/sync/cancel'])(
		'%s needs a JSON body',
		async (url) => {
			const response = await setup(fakeSync()).request(
				url,
				post('name=import', { 'Content-Type': 'text/plain' }),
			);
			expect(response.status).toBe(415);
		},
	);

	test.each(['/api/sync/run', '/api/sync/apply', '/api/sync/cancel'])(
		'%s refuses a body that is too large, and one that is not the right JSON',
		async (url) => {
			const sync = fakeSync();
			const big = await setup(sync).request(
				url,
				post(JSON.stringify({ name: 'x'.repeat(20_000), id: 'x'.repeat(20_000) })),
			);
			expect(big.status).toBe(413);
			for (const body of ['not json', '[]', 'null', '{}', '{"name":1,"id":2}']) {
				const response = await setup(sync).request(url, post(body));
				expect(response.status, body).toBe(400);
			}
			expect(sync.run).not.toHaveBeenCalled();
			expect(sync.apply).not.toHaveBeenCalled();
			expect(sync.cancel).not.toHaveBeenCalled();
		},
	);

	test('a request from another host or another site is refused, as for every route', async () => {
		const host = await setup(fakeSync()).request('http://evil.example/api/sync');
		expect(host.status).toBe(403);
		const site = await setup(fakeSync()).request('/api/sync', {
			headers: {
				Host: 'localhost',
				'Sec-Fetch-Site': 'cross-site',
				Origin: 'https://evil.example',
			},
		});
		expect(site.status).toBe(403);
		const write = await setup(fakeSync()).request(
			'/api/sync/run',
			post(
				{ name: 'import' },
				{ 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' },
			),
		);
		expect(write.status).toBe(403);
	});
});

describe('POST /api/sync/run', () => {
	test('starts the operation by its name, and answers 202 with the id', async () => {
		const sync = fakeSync();
		const response = await setup(sync).request('/api/sync/run', post({ name: 'import' }));
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ id: 'id-1' });
		expect(sync.run).toHaveBeenCalledWith('import');
	});

	test('takes nothing but the name: a path or a script in the body is not read', async () => {
		const sync = fakeSync();
		await setup(sync).request(
			'/api/sync/run',
			post({ name: 'import', script: '/etc/passwd', path: '/etc/passwd', edits: [{}] }),
		);
		expect(sync.run).toHaveBeenCalledTimes(1);
		expect(vi.mocked(sync.run).mock.calls[0]).toEqual(['import']);
	});

	test('answers 409 when a sync is running, and 404 for a name it does not know', async () => {
		const busy = await setup(
			fakeSync({ run: () => ({ ok: false, error: 'busy' }) }),
		).request('/api/sync/run', post({ name: 'import' }));
		expect(busy.status).toBe(409);
		expect(await busy.json()).toMatchObject({ error: 'busy' });
		const unknown = await setup(
			fakeSync({ run: () => ({ ok: false, error: 'unknown' }) }),
		).request('/api/sync/run', post({ name: 'nope' }));
		expect(unknown.status).toBe(404);
		expect(await unknown.json()).toMatchObject({ error: 'unknown' });
	});
});

describe('GET /api/sync/state', () => {
	test('answers what the controller says, from where the screen has read to', async () => {
		const sync = fakeSync();
		const response = await setup(sync).request('/api/sync/state?id=id-1&after=7', GET);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ id: 'id-1', status: 'running' });
		expect(sync.state).toHaveBeenCalledWith('id-1', 7);
	});

	test('reads from the start when after is left out', async () => {
		const sync = fakeSync();
		await setup(sync).request('/api/sync/state?id=id-1', GET);
		expect(sync.state).toHaveBeenCalledWith('id-1', 0);
	});

	test('is 404 for an id it does not hold, and 400 for what is not a request', async () => {
		const none = await setup(fakeSync({ state: () => null })).request(
			'/api/sync/state?id=other',
			GET,
		);
		expect(none.status).toBe(404);
		for (const url of [
			'/api/sync/state',
			`/api/sync/state?id=${'x'.repeat(65)}`,
			'/api/sync/state?id=a&after=-1',
			'/api/sync/state?id=a&after=x',
		]) {
			const response = await setup(fakeSync()).request(url, GET);
			expect(response.status, url).toBe(400);
		}
	});
});

describe('GET /api/sync/changes', () => {
	test('answers a page of the changes of a kind', async () => {
		const sync = fakeSync({
			changes: vi.fn(() => ({
				total: 2,
				changes: [{ kind: 'movedUrl' as const, from: '/a/', to: '/b/' }],
			})),
		});
		const response = await setup(sync).request(
			'/api/sync/changes?id=id-1&kind=movedUrl&offset=1&limit=50',
			GET,
		);
		expect(await response.json()).toEqual({
			total: 2,
			changes: [{ kind: 'movedUrl', from: '/a/', to: '/b/' }],
		});
		expect(sync.changes).toHaveBeenCalledWith('id-1', 'movedUrl', 1, 50);
	});

	test('is 404 for what is not held, and 400 for what is not a request', async () => {
		const none = await setup(fakeSync({ changes: () => null })).request(
			'/api/sync/changes?id=x&kind=meta',
			GET,
		);
		expect(none.status).toBe(404);
		for (const url of [
			'/api/sync/changes',
			'/api/sync/changes?id=x',
			'/api/sync/changes?kind=meta',
			'/api/sync/changes?id=x&kind=meta&offset=-1',
			'/api/sync/changes?id=x&kind=meta&limit=z',
		]) {
			const response = await setup(fakeSync()).request(url, GET);
			expect(response.status, url).toBe(400);
		}
	});
});

describe('POST /api/sync/apply', () => {
	test('applies what was shown by the id, and answers the state', async () => {
		const sync = fakeSync();
		const response = await setup(sync).request('/api/sync/apply', post({ id: 'id-1' }));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ id: 'id-1' });
		expect(sync.apply).toHaveBeenCalledWith('id-1');
	});

	test('takes only the id: edits in the body are not read', async () => {
		const sync = fakeSync();
		await setup(sync).request(
			'/api/sync/apply',
			post({ id: 'id-1', edits: [{ url: '/a/', change: { op: 'deletePage' } }] }),
		);
		expect(vi.mocked(sync.apply).mock.calls).toEqual([['id-1']]);
	});

	test('is 404 for an id it does not hold, and 409 when nothing waits to be applied', async () => {
		const unknown = await setup(
			fakeSync({ apply: () => ({ ok: false, error: 'unknown' }) }),
		).request('/api/sync/apply', post({ id: 'x' }));
		expect(unknown.status).toBe(404);
		const notReady = await setup(
			fakeSync({ apply: () => ({ ok: false, error: 'notReady' }) }),
		).request('/api/sync/apply', post({ id: 'x' }));
		expect(notReady.status).toBe(409);
		expect(await notReady.json()).toMatchObject({ error: 'notReady' });
	});
});

describe('POST /api/sync/cancel', () => {
	test('stops the sync by the id, and says whether there was one to stop', async () => {
		const sync = fakeSync();
		const response = await setup(sync).request('/api/sync/cancel', post({ id: 'id-1' }));
		expect(await response.json()).toEqual({ cancelled: true });
		expect(sync.cancel).toHaveBeenCalledWith('id-1');
		const none = await setup(fakeSync({ cancel: () => false })).request(
			'/api/sync/cancel',
			post({ id: 'old' }),
		);
		expect(await none.json()).toEqual({ cancelled: false });
	});
});

describe('the numbers in a query', () => {
	test('a number in a query that is too long is not a number', async () => {
		const response = await setup(fakeSync()).request(
			'/api/sync/state?id=x&after=1234567890',
			GET,
		);
		expect(response.status).toBe(400);
	});
});
