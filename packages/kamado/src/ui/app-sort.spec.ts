import { describe, expect, test } from 'vitest';

import { createUiApp } from './app.js';

const ROOTS = {
	rootDir: '/home/u/site',
	inputDir: '/home/u/site/src',
	outputDir: '/home/u/site/htdocs',
};
const HOST = { Host: 'localhost' };

/** An app whose editor records the queries the core is asked. */
function setup() {
	const queries: unknown[] = [];
	const editor = {
		handle: 'h1',
		uiPages: (_handle: string, query: string) => {
			queries.push(JSON.parse(query));
			return JSON.stringify({ pages: [], warnings: [] });
		},
		uiRefresh: () => '{}',
		uiEdit: () => '{}',
	};
	const app = createUiApp(editor, { uiDir: '/nowhere', token: 't', roots: ROOTS });
	return { app, queries };
}

describe('GET /api/pages with a sort', () => {
	test('hands the column and the direction to the core', async () => {
		const { app, queries } = setup();
		const response = await app.request('/api/pages?sort=meta:title&desc=true', {
			headers: HOST,
		});
		expect(response.status).toBe(200);
		expect(queries).toEqual([
			{ offset: 0, limit: 100, sort: { key: 'meta:title', desc: true } },
		]);
	});

	test('takes the four columns, ascending when desc is left out', async () => {
		const { app, queries } = setup();
		for (const key of ['url', 'inputPath', 'virtual', 'meta:a b']) {
			const response = await app.request(
				`/api/pages?sort=${encodeURIComponent(key)}&desc=false`,
				{ headers: HOST },
			);
			expect(response.status).toBe(200);
		}
		await app.request('/api/pages?sort=url', { headers: HOST });
		expect(queries).toHaveLength(5);
		expect(queries.at(0)).toMatchObject({ sort: { key: 'url', desc: false } });
		expect(queries.at(-1)).toMatchObject({ sort: { key: 'url', desc: false } });
		expect(queries.at(3)).toMatchObject({ sort: { key: 'meta:a b', desc: false } });
	});

	test('sends no sort when there is none', async () => {
		const { app, queries } = setup();
		await app.request('/api/pages', { headers: HOST });
		expect(queries).toEqual([{ offset: 0, limit: 100 }]);
	});

	test('answers 400 for a column that is not one, and does not ask the core', async () => {
		const { app, queries } = setup();
		const long = `meta:${'k'.repeat(300)}`;
		for (const query of [
			'sort=title',
			'sort=meta:',
			'sort=outputPath',
			`sort=${long}`,
			'sort=url&desc=yes',
			'desc=true',
			'sort=url&desc=1',
		]) {
			const response = await app.request(`/api/pages?${query}`, { headers: HOST });
			expect(response.status, query).toBe(400);
			expect(await response.json()).toMatchObject({ error: 'invalidSort' });
		}
		expect(queries).toEqual([]);
	});
});
