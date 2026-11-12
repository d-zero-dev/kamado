import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const core = {
	uiOpen: vi.fn<(config: string, options: string) => string>(),
	uiPages: vi.fn<(handle: string, query: string) => string>(),
	uiRefresh: vi.fn<(handle: string) => string>(),
	uiEdit: vi.fn<(handle: string, edit: string) => string>(),
	uiServer: vi.fn<(handle: string) => string>(),
	uiClose: vi.fn<(handle: string) => string>(),
};

vi.mock('../native.js', () => ({ native: () => core }));

const { ui } = await import('./start.js');

let dir: string;
const running: { close: () => Promise<void> }[] = [];

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'kamado-ui-start-defaults-'));
	await writeFile(
		path.join(dir, 'index.html'),
		'<meta name="kamado-column-defaults" content="__KAMADO_COLUMN_DEFAULTS__">',
	);
	core.uiOpen.mockReturnValue('h1');
	core.uiClose.mockReturnValue('{"warning":null}');
});

afterEach(async () => {
	for (const editor of running.splice(0)) {
		await editor.close();
	}
	vi.clearAllMocks();
	await rm(dir, { recursive: true, force: true });
});

/**
 * Starts the editor over a core that tells what the config says, and reads the defaults the page
 * of the screen carries.
 * @param server - What `uiServer` answers besides the directories
 */
async function defaultsOf(server: Record<string, unknown>): Promise<unknown> {
	core.uiServer.mockReturnValue(
		JSON.stringify({
			port: 3000,
			open: false,
			inputDir: '/s/src',
			outputDir: '/s/out',
			...server,
		}),
	);
	const editor = await ui('/s/kamado.config.jsonc', {
		port: 0,
		open: false,
		uiDir: dir,
		settingsFile: path.join(dir, 'settings', 'ui-settings.json'),
		write: () => {},
	});
	running.push(editor);
	const response = await fetch(editor.url);
	const html = await response.text();
	const raw = /content="([^"]*)"/.exec(html)?.[1] ?? '';
	return JSON.parse(raw.replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
}

describe('the column defaults of the config reach the screen', () => {
	test('the order and the pinned columns the core tells are in the page', async () => {
		expect(
			await defaultsOf({
				defaultKeyOrder: ['url', 'meta:title'],
				defaultFixedKeys: ['meta:title'],
			}),
		).toEqual({ order: ['url', 'meta:title'], pinned: ['meta:title'] });
	});

	test('an empty list is kept: no column is pinned', async () => {
		expect(await defaultsOf({ defaultKeyOrder: null, defaultFixedKeys: [] })).toEqual({
			pinned: [],
		});
	});

	test('a core that does not say them, or says null, gives none', async () => {
		expect(await defaultsOf({})).toEqual({});
		expect(await defaultsOf({ defaultKeyOrder: null, defaultFixedKeys: null })).toEqual(
			{},
		);
	});
});
