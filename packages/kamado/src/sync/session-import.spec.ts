/* eslint-disable unicorn/no-await-expression-member -- an expectation reads better with the member of what it waits for */
import type { Snapshot } from './diff.js';

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { prepareSync, type SyncEditor } from './session.js';

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'kamado-sync-session-import-'));
});
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

const SNAPSHOT: Snapshot = {
	version: 4,
	overridesHash: 'ov',
	inputDir: '/site/src',
	outputPathField: null,
	warnings: [],
	pages: [
		{
			url: '/a/',
			inputPath: '/site/src/a/index.html',
			outputPath: '/site/out/a/index.html',
			fileSlug: 'a',
			filePathStem: '/a/index',
			extension: '.html',
			depth: 1,
			parent: '/',
			virtual: false,
			meta: { title: 'A' },
			hashes: { input: 'hA', sidecar: null },
		},
	],
};

const uiRefresh = vi.fn<SyncEditor['uiRefresh']>();
const uiSyncPages = vi.fn<SyncEditor['uiSyncPages']>();
const uiSyncLocked = vi.fn<SyncEditor['uiSyncLocked']>();
const uiEditBatch = vi.fn<SyncEditor['uiEditBatch']>();
const editor: SyncEditor = {
	handle: 'h1',
	uiRefresh,
	uiSyncPages,
	uiSyncLocked,
	uiEditBatch,
};

beforeEach(() => {
	uiRefresh.mockReset().mockReturnValue('{"version":4}');
	uiSyncPages.mockReset().mockReturnValue(JSON.stringify(SNAPSHOT));
	uiSyncLocked.mockReset().mockReturnValue('{"version":1,"locked":{}}');
	uiEditBatch.mockReset();
});

let count = 0;
/**
 * Writes a script and returns its path.
 * @param body - The module of the script
 */
function script(body: string): string {
	const file = path.join(dir, `s-${count++}.mjs`);
	writeFileSync(file, body);
	return file;
}

const prepare = (body: string, extra: object = {}) =>
	prepareSync({ editor, script: script(body), cwd: dir, onLog: () => {}, ...extra });

describe('prepareSync (import)', () => {
	test('gives the script the pages without the hashes and the locks, and the directory of the input', async () => {
		const lines: string[] = [];
		const prepared = await prepareSync({
			editor,
			script: script(
				'export default { read: async (pages, ctx) => { ctx.log("info", JSON.stringify({ pages, dir: ctx.inputDir })); return []; } };',
			),
			cwd: dir,
			onLog: (log) => lines.push(log.message),
		});
		expect(prepared.kind).toBe('review');
		const { pages, dir: inputDir } = JSON.parse(lines[0]!) as {
			pages: Record<string, unknown>[];
			dir: string;
		};
		expect(inputDir).toBe('/site/src');
		const { hashes, ...entry } = SNAPSHOT.pages[0]!;
		expect(hashes).toBeDefined();
		expect(pages).toEqual([entry]);
	});

	test('runs the script in the directory of the config, wherever the editor was started', async () => {
		const lines: string[] = [];
		await prepareSync({
			editor,
			script: script(
				'export default { read: async (pages, ctx) => { ctx.log("info", process.cwd()); return []; } };',
			),
			cwd: dir,
			onLog: (log) => lines.push(log.message),
		});
		expect(realpathSync(lines[0]!)).toBe(realpathSync(dir));
		expect(realpathSync(dir)).not.toBe(realpathSync(process.cwd()));
	});

	test('returns no change when what the script returns is what the site is', async () => {
		const prepared = await prepare('export default { read: async (pages) => pages };');
		expect(prepared).toMatchObject({
			kind: 'nochange',
			direction: 'import',
			summary: {
				counts: {
					added: 0,
					deleted: 0,
					movedUrl: 0,
					movedFile: 0,
					virtualized: 0,
					materialized: 0,
					meta: 0,
				},
				changes: [],
				unsaved: [],
			},
		});
		expect(uiEditBatch).not.toHaveBeenCalled();
	});

	test('tells every problem of what the script returned, and writes nothing', async () => {
		const prepared = await prepare(
			'export default { read: async () => [{ url: "no" }, { url: "/n/" }] };',
		);
		expect(prepared).toMatchObject({ kind: 'invalid' });
		expect(prepared.kind === 'invalid' && prepared.problems).toHaveLength(2);
		expect(uiEditBatch).not.toHaveBeenCalled();
	});

	test('tells how the script failed, with its stack, and does not look for a difference', async () => {
		const prepared = await prepare(
			'export default { read: async () => { throw new Error("no sheet"); } };',
		);
		expect(prepared).toMatchObject({ kind: 'failed', message: 'no sheet' });
		expect(prepared.kind === 'failed' && prepared.stack).toContain('no sheet');
		expect(uiEditBatch).not.toHaveBeenCalled();
	});

	test('tells that git cannot bring anything back where there is no repository', async () => {
		const prepared = await prepare('export default { read: async () => [] };');
		expect(prepared).toMatchObject({
			kind: 'review',
			direction: 'import',
			summary: { gitUnavailable: true, unsaved: [] },
		});
	});
});

describe('the keys that cannot be edited (import)', () => {
	test('are not asked for when no key is changed', async () => {
		await prepare('export default { read: async (pages) => pages };');
		await prepare('export default { read: async () => [] };');
		expect(uiSyncLocked).not.toHaveBeenCalled();
	});

	test('are asked for the pages whose keys are changed, once, and a change of one is refused', async () => {
		uiSyncLocked.mockReturnValue(
			JSON.stringify({
				version: 4,
				locked: { '/a/': { title: 'the front matter is a flow mapping' } },
			}),
		);
		const prepared = await prepare(
			'export default { read: async () => [{ url: "/a/", meta: { title: "changed" } }] };',
		);
		expect(uiSyncLocked).toHaveBeenCalledTimes(1);
		expect(JSON.parse(uiSyncLocked.mock.calls[0]![1])).toEqual({ urls: ['/a/'] });
		expect(prepared).toMatchObject({ kind: 'invalid' });
		expect(prepared.kind === 'invalid' && prepared.problems[0]?.message).toBe(
			'row 1 (/a/): the key title cannot be changed: the front matter is a flow mapping',
		);
		expect(uiEditBatch).not.toHaveBeenCalled();
	});

	test('let a change of a key that is not locked through', async () => {
		const prepared = await prepare(
			'export default { read: async () => [{ url: "/a/", meta: { title: "changed" } }] };',
		);
		expect(uiSyncLocked).toHaveBeenCalledTimes(1);
		expect(prepared.kind).toBe('review');
	});
});

describe('the files git cannot bring back (import)', () => {
	test('are named in the summary when a page that goes has changes that are not committed', async () => {
		vi.stubEnv('GIT_CONFIG_GLOBAL', devNull);
		vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
		const repo = mkdtempSync(path.join(tmpdir(), 'kamado-sync-import-repo-'));
		try {
			const git = (...args: string[]) =>
				execFileSync(
					'git',
					['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args],
					{
						cwd: repo,
					},
				);
			git('init', '-q', '-b', 'main');
			mkdirSync(path.join(repo, 'src', 'a'), { recursive: true });
			writeFileSync(path.join(repo, 'src', 'a', 'index.html'), 'committed\n');
			git('add', '-A');
			git('commit', '-q', '-m', 'first');
			writeFileSync(
				path.join(repo, 'src', 'a', 'index.html'),
				'edited and not committed\n',
			);
			uiSyncPages.mockReturnValue(
				JSON.stringify({
					...SNAPSHOT,
					inputDir: path.join(repo, 'src'),
					pages: [
						{
							...SNAPSHOT.pages[0],
							inputPath: path.join(repo, 'src', 'a', 'index.html'),
						},
					],
				}),
			);
			const prepared = await prepareSync({
				editor,
				script: script('export default { read: async () => [] };'),
				cwd: repo,
				onLog: () => {},
			});
			expect(prepared).toMatchObject({
				kind: 'review',
				summary: { unsaved: ['a/index.html'] },
			});
			expect(
				prepared.kind === 'review' &&
					prepared.direction === 'import' &&
					prepared.summary.gitUnavailable,
			).toBeUndefined();
		} finally {
			vi.unstubAllEnvs();
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

describe('apply (import)', () => {
	const review = async () => {
		const prepared = await prepare(
			'export default { read: async () => [{ url: "/moved/", inputPath: "a/index.html", meta: { title: "B" } }] };',
		);
		if (prepared.kind !== 'review' || prepared.direction !== 'import') {
			throw new Error(prepared.kind);
		}
		return prepared;
	};

	test('sends every edit in one batch, with the hashes the script was given', async () => {
		uiEditBatch.mockReturnValue('{"ok":true,"version":5,"overridesHash":"x","count":2}');
		const prepared = await review();
		expect(uiEditBatch).not.toHaveBeenCalled();
		expect(prepared.apply()).toEqual({ ok: true, count: 2 });
		expect(uiEditBatch).toHaveBeenCalledTimes(1);
		const [handle, json] = uiEditBatch.mock.calls[0]!;
		expect(handle).toBe('h1');
		expect(JSON.parse(json)).toEqual({
			edits: [
				{
					url: '/a/',
					expect: { input: 'hA', sidecar: null, overrides: 'ov' },
					change: { op: 'moveUrl', url: '/moved/' },
				},
				{
					url: '/a/',
					expect: { input: 'hA', sidecar: null, overrides: 'ov' },
					change: { op: 'set', key: 'title', value: 'B' },
				},
			],
		});
	});

	test('tells which edit the core refused, by the page and the operation', async () => {
		uiEditBatch.mockReturnValue(
			JSON.stringify({
				ok: false,
				code: 'conflict',
				message: 'a.html was changed after it was read',
				errors: [
					{ index: 0, code: 'conflict', message: 'a.html was changed after it was read' },
					{ index: null, code: 'io', message: 'cannot write' },
				],
			}),
		);
		const result = (await review()).apply();
		expect(result).toEqual({
			ok: false,
			code: 'conflict',
			message: 'a.html was changed after it was read',
			failures: [
				{
					url: '/a/',
					op: 'moveUrl',
					code: 'conflict',
					message: 'a.html was changed after it was read',
				},
				{ url: null, op: null, code: 'io', message: 'cannot write' },
			],
		});
	});

	test('tells a failure of the call itself as one that no edit is behind', async () => {
		uiEditBatch.mockImplementation(() => {
			throw new Error('no editor');
		});
		expect((await review()).apply()).toEqual({
			ok: false,
			code: 'failed',
			message: 'no editor',
			failures: [{ url: null, op: null, code: 'failed', message: 'no editor' }],
		});
	});
});
