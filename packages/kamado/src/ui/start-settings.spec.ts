import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
let file: string;
const running: { close: () => Promise<void> }[] = [];

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'kamado-ui-start-settings-'));
	file = path.join(dir, 'settings', 'ui-settings.json');
	await writeFile(
		path.join(dir, 'index.html'),
		'<meta name="kamado-token" content="__KAMADO_TOKEN__">',
	);
	core.uiOpen.mockReturnValue('h1');
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
 * Starts the editor on a free port, over the fake core, with its settings in the temporary
 * directory.
 * @param config - The path of the config file
 */
async function start(config = '/s/kamado.config.jsonc') {
	const lines: string[] = [];
	const editor = await ui(config, {
		port: 0,
		open: false,
		uiDir: dir,
		settingsFile: file,
		write: (text) => lines.push(text),
	});
	running.push(editor);
	return { editor, lines };
}

/**
 * The token the screen's page carries.
 * @param url - Where the editor listens
 */
async function tokenOf(url: string): Promise<string> {
	const response = await fetch(url);
	const html = await response.text();
	return /content="([^"]+)"/.exec(html)?.[1] ?? '';
}

describe('ui settings', () => {
	test('the screen saves its settings in the file, under the project of the config file', async () => {
		const { editor } = await start();
		const token = await tokenOf(editor.url);
		const response = await fetch(new URL('api/settings', editor.url), {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json', 'X-Kamado-Token': token },
			body: JSON.stringify({ project: { pageSize: 1000 } }),
		});
		expect(response.status).toBe(200);
		const saved = JSON.parse(await readFile(file, 'utf8')) as {
			projects: Record<string, { pageSize: number }>;
		};
		expect(saved.projects['/s/kamado.config.jsonc']?.pageSize).toBe(1000);
		const readAgain = await fetch(new URL('api/settings', editor.url));
		const again = (await readAgain.json()) as {
			project: { pageSize: number };
		};
		expect(again.project.pageSize).toBe(1000);
	});

	test('a broken file is put aside at the start and said on the terminal with its path', async () => {
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, '{ broken');
		const { lines } = await start();
		expect(lines.join('')).toMatch(/warning: .*\.bak.*ui-settings\.json/);
		const names = await readdir(path.dirname(file));
		expect(names.some((name) => name.endsWith('.bak'))).toBe(true);
	});

	test('starts with nothing written when there are no settings yet', async () => {
		await start();
		await expect(readdir(path.dirname(file))).rejects.toMatchObject({ code: 'ENOENT' });
	});
});
