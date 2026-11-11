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

const ROWS = JSON.stringify({
	version: 1,
	total: 0,
	columns: [],
	overridesHash: null,
	pages: [],
	warnings: [],
});

let dir: string;
const running: { close: () => Promise<void> }[] = [];

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'kamado-ui-start-'));
	await writeFile(path.join(dir, 'index.html'), '<p>screen</p>');
	core.uiOpen.mockReturnValue('h1');
	core.uiPages.mockReturnValue(ROWS);
	core.uiServer.mockReturnValue(
		JSON.stringify({ port: 3000, open: false, inputDir: '/s/src', outputDir: '/s/out' }),
	);
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
 * Starts the editor on a free port, over the fake core.
 * @param options - Options on top of the free port and the temporary screen
 */
async function start(options: Parameters<typeof ui>[1] = {}) {
	const lines: string[] = [];
	const editor = await ui('/s/kamado.config.jsonc', {
		port: 0,
		open: false,
		uiDir: dir,
		write: (text) => lines.push(text),
		...options,
	});
	running.push(editor);
	return { editor, lines };
}

describe('ui', () => {
	test('refuses an unknown option before the core is called', async () => {
		await expect(
			ui('/s/kamado.config.jsonc', { port: 0, typo: true } as never),
		).rejects.toThrow('unknown option: typo');
		expect(core.uiOpen).not.toHaveBeenCalled();
	});

	test('serves the screen and the calls at the url it returns', async () => {
		const { editor } = await start();
		expect(editor.url).toMatch(/^http:\/\/localhost:\d+\/$/);
		const page = await fetch(editor.url);
		expect(await page.text()).toBe('<p>screen</p>');
		const rows = await fetch(new URL('api/pages?limit=5', editor.url));
		expect(rows.status).toBe(200);
		expect(core.uiPages).toHaveBeenCalledWith('h1', '{"offset":0,"limit":5}');
	});

	test('passes cacheDir to the core and says where it listens', async () => {
		const { editor, lines } = await start({ cacheDir: '/s/.cache' });
		expect(JSON.parse(core.uiOpen.mock.calls[0]?.[1] ?? '')).toEqual({
			cacheDir: '/s/.cache',
		});
		expect(lines.join('')).toContain(editor.url);
	});

	test('close stops listening and lets the editor go, once', async () => {
		const { editor } = await start();
		await editor.close();
		await editor.close();
		expect(core.uiClose).toHaveBeenCalledTimes(1);
		await expect(fetch(editor.url)).rejects.toThrow();
	});

	test('a warning of the core, when it lets go of the editor, is written', async () => {
		core.uiClose.mockReturnValue('{"warning":"the cache was not written"}');
		const { editor, lines } = await start();
		await editor.close();
		expect(lines.join('')).toContain('the cache was not written');
	});

	test('a port that is in use fails, naming it, and the editor is let go', async () => {
		const { editor } = await start();
		const port = Number(new URL(editor.url).port);
		await expect(start({ port })).rejects.toThrow(`port ${port} is already in use`);
		// The first editor is still open; only the one that failed was let go.
		expect(core.uiClose).toHaveBeenCalledTimes(1);
	});

	test('the port after devServer.port is out of range at 65535, and says to give one', async () => {
		core.uiServer.mockReturnValue(
			JSON.stringify({
				port: 65_535,
				open: false,
				inputDir: '/s/src',
				outputDir: '/s/out',
			}),
		);
		await expect(
			ui('/s/kamado.config.jsonc', { open: false, uiDir: dir, write: () => {} }),
		).rejects.toThrow(/out of range: give one with --port/);
		expect(core.uiClose).toHaveBeenCalledTimes(1);
	});

	test('a port that is not one fails', async () => {
		await expect(start({ port: 70_000 })).rejects.toThrow(/cannot be used/);
		expect(core.uiClose).toHaveBeenCalledTimes(1);
	});

	test('a core that cannot open the site throws before anything listens', async () => {
		core.uiOpen.mockImplementation(() => {
			throw new Error('cannot read config /s/kamado.config.jsonc');
		});
		await expect(start()).rejects.toThrow(/cannot read config/);
		expect(core.uiClose).not.toHaveBeenCalled();
	});
});
