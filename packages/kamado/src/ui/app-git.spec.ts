import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createUiApp } from './app.js';

const ROOTS = {
	rootDir: '/home/u/site',
	inputDir: '/home/u/site/src',
	outputDir: '/home/u/site/htdocs',
};
const HOST = { Host: 'localhost' };

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'kamado-ui-git-'));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/**
 * An app over an editor that is never asked anything.
 * @param git - What the app reads the repository with
 */
function setup(git?: () => Promise<{ branch: string | null; sha: string } | null>) {
	const editor = {
		handle: 'h1',
		uiPages: vi.fn<(handle: string, query: string) => string>(),
		uiRefresh: vi.fn<(handle: string) => string>(),
		uiEdit: vi.fn<(handle: string, edit: string) => string>(),
		uiValues: vi.fn<(handle: string, query: string) => string>(),
	};
	return createUiApp(editor, {
		uiDir: dir,
		token: 'a-token-for-the-test',
		roots: ROOTS,
		...(git === undefined ? {} : { git }),
	});
}

describe('GET /api/git', () => {
	test('answers the branch and the commit, and is not kept', async () => {
		const read = vi.fn(() => Promise.resolve({ branch: 'main', sha: '51df987' }));
		const response = await setup(read).request('/api/git', { headers: HOST });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ branch: 'main', sha: '51df987' });
		expect(response.headers.get('cache-control')).toBe('no-store');
	});

	test('reads the repository for each request: the branch can be switched', async () => {
		const read = vi
			.fn<() => Promise<{ branch: string | null; sha: string } | null>>()
			.mockResolvedValueOnce({ branch: 'main', sha: '51df987' })
			.mockResolvedValueOnce({ branch: 'other', sha: '51df987' });
		const app = setup(read);
		await app.request('/api/git', { headers: HOST });
		const again = await app.request('/api/git', { headers: HOST });
		expect(await again.json()).toEqual({ branch: 'other', sha: '51df987' });
		expect(read).toHaveBeenCalledTimes(2);
	});

	test('answers null when there is nothing to show', async () => {
		const response = await setup(() => Promise.resolve(null)).request('/api/git', {
			headers: HOST,
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toBeNull();
	});

	test('answers null, and not an error, when reading fails or there is no reader', async () => {
		const failing = await setup(() => Promise.reject(new Error('boom'))).request(
			'/api/git',
			{ headers: HOST },
		);
		expect(failing.status).toBe(200);
		expect(await failing.json()).toBeNull();
		const none = await setup().request('/api/git', { headers: HOST });
		expect(await none.json()).toBeNull();
		// a reader that throws before it returns a promise is a failure to read too
		const sync = await setup(() => {
			throw new Error('boom');
		}).request('/api/git', { headers: HOST });
		expect(sync.status).toBe(200);
		expect(await sync.json()).toBeNull();
	});

	test('is refused to a host that is not the loopback and to another site, as the other routes are', async () => {
		const app = setup(() => Promise.resolve({ branch: 'main', sha: '51df987' }));
		const host = await app.request('http://evil.example/api/git');
		expect(host.status).toBe(403);
		const site = await app.request('/api/git', {
			headers: {
				...HOST,
				'Sec-Fetch-Site': 'cross-site',
				Origin: 'https://evil.example',
			},
		});
		expect(site.status).toBe(403);
	});
});
