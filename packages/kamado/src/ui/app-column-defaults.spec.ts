import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
	COLUMN_DEFAULTS_PLACEHOLDER,
	createUiApp,
	TOKEN_PLACEHOLDER,
	type ColumnDefaults,
} from './app.js';

const TOKEN = 'a-token-for-the-test';
const ROOTS = { rootDir: '/s', inputDir: '/s/src', outputDir: '/s/out' };
const HOST = { Host: 'localhost' };

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'kamado-ui-defaults-'));
	await writeFile(
		path.join(dir, 'index.html'),
		`<meta name="kamado-token" content="${TOKEN_PLACEHOLDER}"><meta name="kamado-column-defaults" content="${COLUMN_DEFAULTS_PLACEHOLDER}">`,
	);
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/**
 * The page the app serves, over a fake editor.
 * @param columnDefaults - What the config gives
 */
async function page(columnDefaults?: ColumnDefaults): Promise<string> {
	const editor = {
		handle: 'h1',
		uiPages: vi.fn<(handle: string, query: string) => string>(),
		uiValues: vi.fn<(handle: string, query: string) => string>(),
		uiRefresh: vi.fn<(handle: string) => string>(),
		uiEdit: vi.fn<(handle: string, edit: string) => string>(),
	};
	const app = createUiApp(editor, {
		uiDir: dir,
		token: TOKEN,
		roots: ROOTS,
		...(columnDefaults === undefined ? {} : { columnDefaults }),
	});
	const response = await app.request('/', { headers: HOST });
	return response.text();
}

/**
 * What the screen reads out of the page: the attribute, decoded as a browser decodes it.
 * @param html - The page
 */
function defaultsIn(html: string): unknown {
	const raw = /name="kamado-column-defaults" content="([^"]*)"/.exec(html)?.[1] ?? '';
	const text = raw
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>')
		.replaceAll('&quot;', '"')
		.replaceAll('&amp;', '&');
	return JSON.parse(text);
}

describe('the column defaults of the config in the page', () => {
	test('the page carries the order and the pinned columns as the config wrote them', async () => {
		const html = await page({
			order: ['url', 'meta:title', 'inputPath'],
			pinned: ['url', 'meta:title'],
		});
		expect(defaultsIn(html)).toEqual({
			order: ['url', 'meta:title', 'inputPath'],
			pinned: ['url', 'meta:title'],
		});
		expect(html).toContain(`content="${TOKEN}"`);
		expect(html).not.toContain(COLUMN_DEFAULTS_PLACEHOLDER);
	});

	test('an empty list is carried: no column is pinned', async () => {
		expect(defaultsIn(await page({ pinned: [] }))).toEqual({ pinned: [] });
	});

	test('a config that writes neither gives an empty object', async () => {
		expect(defaultsIn(await page())).toEqual({});
		expect(defaultsIn(await page({}))).toEqual({});
	});

	test('a key with a quote, an angle bracket, an ampersand or a $ cannot leave the attribute', async () => {
		const keys = ['meta:a"b', 'meta:<script>', 'meta:a&amp;b', 'meta:$&$1', "meta:'x'"];
		const html = await page({ order: keys });
		expect(defaultsIn(html)).toEqual({ order: keys });
		const attribute = /name="kamado-column-defaults" content="([^"]*)"/.exec(html)?.[1];
		expect(attribute).not.toMatch(/[<>"]/);
	});

	test('a placeholder inside a key is not replaced again', async () => {
		const keys = [`meta:${TOKEN_PLACEHOLDER}`, `meta:${COLUMN_DEFAULTS_PLACEHOLDER}`];
		const html = await page({ order: keys });
		expect(defaultsIn(html)).toEqual({ order: keys });
		expect(html.match(new RegExp(TOKEN, 'g'))).toHaveLength(1);
	});
});
