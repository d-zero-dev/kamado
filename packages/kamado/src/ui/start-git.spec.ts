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
const readGit =
	vi.fn<(cwd: string) => Promise<{ branch: string | null; sha: string } | null>>();

vi.mock('../native.js', () => ({ native: () => core }));
vi.mock('./git.js', () => ({ cachedReadGit: (cwd: string) => () => readGit(cwd) }));

const { ui } = await import('./start.js');

let dir: string;
const running: { close: () => Promise<void> }[] = [];

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'kamado-ui-start-git-'));
	await writeFile(path.join(dir, 'index.html'), '<p>screen</p>');
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

describe('ui and the repository of the site', () => {
	test('answers /api/git with what is read in the directory of the config file', async () => {
		readGit.mockResolvedValue({ branch: 'main', sha: '51df987' });
		const editor = await ui('/s/kamado.config.jsonc', {
			port: 0,
			open: false,
			uiDir: dir,
			write: () => {},
			settingsFile: path.join(dir, 'settings.json'),
		});
		running.push(editor);
		const answer = await fetch(new URL('api/git', editor.url));
		expect(answer.status).toBe(200);
		expect(await answer.json()).toEqual({ branch: 'main', sha: '51df987' });
		expect(readGit).toHaveBeenCalledWith('/s');
	});
});
