import { describe, expect, test } from 'vitest';

import { createUiApp, MAX_VALUES } from './app.js';

const ROOTS = {
	rootDir: '/home/u/site',
	inputDir: '/home/u/site/src',
	outputDir: '/home/u/site/htdocs',
};
const HOST = { Host: 'localhost' };

/**
 * An app whose editor records the queries for values the core is asked.
 * @param answer
 */
function setup(answer: () => string = () => '{"values":[],"total":0}') {
	const queries: unknown[] = [];
	const editor = {
		handle: 'h1',
		uiPages: () => '{}',
		uiRefresh: () => '{}',
		uiEdit: () => '{}',
		uiValues: (_handle: string, query: string) => {
			queries.push(JSON.parse(query));
			return answer();
		},
	};
	const app = createUiApp(editor, { uiDir: '/nowhere', token: 't', roots: ROOTS });
	return { app, queries };
}

describe('GET /api/values', () => {
	test('hands the key and the limit to the core and passes its answer on', async () => {
		const answer = {
			version: 3,
			key: 'meta:layout',
			total: 1,
			values: [{ value: 'wide', count: 2 }],
		};
		const { app, queries } = setup(() => JSON.stringify(answer));
		const response = await app.request('/api/values?key=meta:layout&limit=50', {
			headers: HOST,
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(answer);
		expect(queries).toEqual([{ key: 'meta:layout', limit: 50 }]);
	});

	test('takes a key with characters that need escaping in a URL', async () => {
		const { app, queries } = setup();
		const response = await app.request(
			`/api/values?key=${encodeURIComponent('meta:a b&c')}`,
			{ headers: HOST },
		);
		expect(response.status).toBe(200);
		expect(queries).toEqual([{ key: 'meta:a b&c', limit: 100 }]);
	});

	test('takes as many values as the limit allows', async () => {
		const { app, queries } = setup();
		const response = await app.request(`/api/values?key=meta:a&limit=${MAX_VALUES}`, {
			headers: HOST,
		});
		expect(response.status).toBe(200);
		expect(queries).toEqual([{ key: 'meta:a', limit: MAX_VALUES }]);
	});

	test('answers 400 for a request that is not one, and does not ask the core', async () => {
		const { app, queries } = setup();
		const long = `meta:${'k'.repeat(300)}`;
		for (const query of [
			'',
			'limit=10',
			'key=layout',
			'key=meta:',
			'key=url',
			'key=sidecar&limit=1',
			`key=${long}`,
			'key=meta:a&limit=0',
			`key=meta:a&limit=${MAX_VALUES + 1}`,
			'key=meta:a&limit=-1',
			'key=meta:a&limit=1.5',
			'key=meta:a&limit=ten',
		]) {
			const response = await app.request(`/api/values?${query}`, { headers: HOST });
			expect(response.status, query).toBe(400);
			expect(await response.json()).toMatchObject({ error: 'invalid' });
		}
		expect(queries).toEqual([]);
	});

	test('answers 500 with the message of the core, told without the directories of the machine', async () => {
		const { app } = setup(() => {
			throw new Error('cannot read /home/u/site/src/a.html');
		});
		const response = await app.request('/api/values?key=meta:a', { headers: HOST });
		expect(response.status).toBe(500);
		const body = (await response.json()) as { error: string; message: string };
		expect(body.error).toBe('failed');
		expect(body.message).toContain('<input>/a.html');
		expect(body.message).not.toContain('/home/u');
	});

	test('is not cached, as every answer is not', async () => {
		const { app } = setup();
		const response = await app.request('/api/values?key=meta:a', { headers: HOST });
		expect(response.headers.get('cache-control')).toBe('no-store');
	});
});
