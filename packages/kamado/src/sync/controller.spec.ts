/* eslint-disable unicorn/no-await-expression-member -- an expectation reads better with the member of what it waits for */
import type { Snapshot } from './diff.js';
import type { SyncEditor } from './session.js';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import {
	createSyncController,
	MAX_CHANGES,
	MAX_LOG_LINES,
	MAX_PROBLEMS,
	type SyncController,
	type SyncState,
} from './controller.js';

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'kamado-sync-controller-'));
});
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

const entry = (url: string, rel: string, meta: Record<string, unknown> = {}) => ({
	url,
	inputPath: `/site/src/${rel}`,
	outputPath: `/site/out${url}`,
	fileSlug: 'x',
	filePathStem: `/${rel}`,
	extension: '.html',
	depth: 1,
	parent: '/',
	virtual: false,
	meta,
	hashes: { input: `h:${rel}`, sidecar: null },
	locked: {},
});

const SNAPSHOT: Snapshot = {
	version: 1,
	overridesHash: 'ov',
	inputDir: '/site/src',
	outputPathField: null,
	warnings: [],
	pages: [entry('/a/', 'a/index.html', { title: 'A' }), entry('/b/', 'b/index.html')],
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

let count = 0;
/**
 *
 * @param body
 */
function script(body: string): string {
	const file = path.join(dir, `s-${count++}.mjs`);
	writeFileSync(file, body);
	return file;
}

/**
 *
 * @param scripts
 * @param scrub
 */
function controllerOf(
	scripts: Record<string, string>,
	scrub = (t: string) => t,
): SyncController {
	return createSyncController({
		editor,
		functions: Object.entries(scripts).map(([name, body]) => ({
			name,
			label: { en: name },
			script: script(body),
		})),
		cwd: dir,
		scrub,
	});
}

/**
 * Waits until the sync of `id` is no longer running.
 * @param sync
 * @param id
 */
async function finished(sync: SyncController, id: string): Promise<SyncState> {
	let state: SyncState | null = null;
	await vi.waitFor(() => {
		state = sync.state(id, 0);
		expect(state?.status).not.toBe('running');
	});
	return state!;
}

/**
 *
 * @param sync
 * @param name
 */
function started(sync: SyncController, name: string): string {
	const answer = sync.run(name);
	if (!answer.ok) {
		throw new Error(answer.error);
	}
	return answer.id;
}

beforeEach(() => {
	uiRefresh.mockReset().mockReturnValue('{"version":1}');
	uiSyncPages.mockReset().mockReturnValue(JSON.stringify(SNAPSHOT));
	uiSyncLocked.mockReset().mockReturnValue('{"version":1,"locked":{}}');
	uiEditBatch
		.mockReset()
		.mockReturnValue('{"ok":true,"version":2,"overridesHash":"x","count":1}');
});

describe('functions', () => {
	test('tells the names and the labels as written, and never a path', () => {
		const sync = controllerOf({ import: 'export default () => null;' });
		expect(sync.functions()).toEqual([{ name: 'import', label: { en: 'import' } }]);
		expect(JSON.stringify(sync.functions())).not.toContain(dir);
	});
});

describe('run', () => {
	test('starts the operation by its name, and reads the files again first', async () => {
		const sync = controllerOf({ nothing: 'export default async () => null;' });
		const id = started(sync, 'nothing');
		expect(uiRefresh).toHaveBeenCalledWith('h1');
		// the script has not been heard from yet: it runs
		expect(sync.state(id, 0)?.status).toBe('running');
		expect((await finished(sync, id)).status).toBe('nothing');
	});

	test('does not take a path or a name it does not know', () => {
		const sync = controllerOf({ op: 'export default async () => null;' });
		expect(sync.run('/etc/passwd')).toEqual({ ok: false, error: 'unknown' });
		expect(sync.run('nope')).toEqual({ ok: false, error: 'unknown' });
		expect(sync.run('')).toEqual({ ok: false, error: 'unknown' });
	});

	test('does not start a second sync while one runs, and does when it has ended', async () => {
		const sync = controllerOf({
			slow: 'export default async () => { await new Promise(() => {}); };',
			quick: 'export default async () => null;',
		});
		const id = started(sync, 'slow');
		expect(sync.run('quick')).toEqual({ ok: false, error: 'busy' });
		expect(sync.run('slow')).toEqual({ ok: false, error: 'busy' });
		expect(sync.cancel(id)).toBe(true);
		expect((await finished(sync, id)).status).toBe('cancelled');
		const next = started(sync, 'quick');
		expect(next).not.toBe(id);
		expect((await finished(sync, next)).status).toBe('nothing');
	});

	test('a sync that was replaced is not found any more', async () => {
		const sync = controllerOf({ quick: 'export default async () => null;' });
		const first = started(sync, 'quick');
		await finished(sync, first);
		const second = started(sync, 'quick');
		expect(sync.state(first, 0)).toBeNull();
		expect(sync.apply(first)).toEqual({ ok: false, error: 'unknown' });
		expect(sync.cancel(first)).toBe(false);
		expect(sync.changes(first, 'deleted', 0, 10)).toBeNull();
		await finished(sync, second);
	});

	test('the id is not guessable from the one before', () => {
		const sync = controllerOf({ quick: 'export default async () => null;' });
		const a = started(sync, 'quick');
		expect(a).toMatch(/^[0-9a-f-]{36}$/u);
		expect(sync.state('1', 0)).toBeNull();
		expect(sync.state('', 0)).toBeNull();
	});
});

describe('the log', () => {
	test('is told as the script writes it, from where the screen has read to', async () => {
		const sync = controllerOf({
			talk: `export default async (pages, ctx) => {
				ctx.log('info', 'one'); ctx.log('warn', 'two'); ctx.log('error', 'three');
				return null;
			};`,
		});
		const id = started(sync, 'talk');
		const done = await finished(sync, id);
		expect(done.log).toEqual([
			{ type: 'info', message: 'one' },
			{ type: 'warn', message: 'two' },
			{ type: 'error', message: 'three' },
		]);
		expect(done.next).toBe(3);
		expect(done.dropped).toBe(0);
		expect(sync.state(id, 2)?.log).toEqual([{ type: 'error', message: 'three' }]);
		expect(sync.state(id, 3)?.log).toEqual([]);
		expect(sync.state(id, 99)?.log).toEqual([]);
	});

	test('spells out controls, takes the paths of the machine out, and cuts a long line', async () => {
		const esc = String.fromCodePoint(27);
		const sync = controllerOf(
			{
				talk: `export default async (pages, ctx) => {
					ctx.log('info', ${JSON.stringify(`/secret/root/file.json${esc}[2J`)});
					ctx.log('info', 'x'.repeat(5000));
					return null;
				};`,
			},
			(text) => text.replaceAll('/secret/root', '<root>'),
		);
		const id = started(sync, 'talk');
		const [first, second] = (await finished(sync, id)).log;
		expect(first?.message).toBe(String.raw`<root>/file.json\x1B[2J`);
		expect([...second!.message]).toHaveLength(2000);
	});

	test('keeps the last lines and says how many were dropped', async () => {
		const sync = controllerOf({
			flood: `export default async (pages, ctx) => {
				for (let i = 0; i < ${MAX_LOG_LINES + 25}; i++) ctx.log('info', 'line ' + i);
				return null;
			};`,
		});
		const id = started(sync, 'flood');
		const done = await finished(sync, id);
		expect(done.log).toHaveLength(MAX_LOG_LINES);
		expect(done.dropped).toBe(25);
		expect(done.next).toBe(MAX_LOG_LINES + 25);
		expect(done.log[0]?.message).toBe('line 25');
		// a screen that had read up to line 10 gets what is left, and is told what it missed
		expect(sync.state(id, 10)?.log).toHaveLength(MAX_LOG_LINES);
		expect(sync.state(id, MAX_LOG_LINES + 20)?.log.map((l) => l.message)).toEqual([
			`line ${MAX_LOG_LINES + 20}`,
			`line ${MAX_LOG_LINES + 21}`,
			`line ${MAX_LOG_LINES + 22}`,
			`line ${MAX_LOG_LINES + 23}`,
			`line ${MAX_LOG_LINES + 24}`,
		]);
	});
});

describe('how a sync ends', () => {
	test('a failure is told with its message and its stack, without the paths of the machine', async () => {
		const sync = controllerOf(
			{
				fail: 'export default async () => { throw new Error("no sheet at /secret/root"); };',
			},
			(text) => text.replaceAll('/secret/root', '<root>'),
		);
		const id = started(sync, 'fail');
		const done = await finished(sync, id);
		expect(done.status).toBe('failed');
		expect(done.failure?.message).toBe('no sheet at <root>');
		expect(done.failure?.stack).toContain('no sheet at <root>');
		expect(done.failure?.stack).not.toContain('/secret/root');
		expect(uiEditBatch).not.toHaveBeenCalled();
	});

	test('a failure of the core to list the pages is a failure of the sync', async () => {
		uiSyncPages.mockImplementation(() => {
			throw new Error('cannot read pages.overrides');
		});
		const sync = controllerOf({ op: 'export default async () => null;' });
		const id = started(sync, 'op');
		const done = await finished(sync, id);
		expect(done).toMatchObject({
			status: 'failed',
			failure: { message: 'cannot read pages.overrides', stack: null },
		});
		// and the next can be started
		uiSyncPages.mockReturnValue(JSON.stringify(SNAPSHOT));
		expect(sync.run('op').ok).toBe(true);
	});

	test('what is the same as the site has no change', async () => {
		const sync = controllerOf({ same: 'export default async (pages) => pages;' });
		const done = await finished(sync, started(sync, 'same'));
		expect(done.status).toBe('nochange');
		expect(done.summary).toMatchObject({ total: 0, gitUnavailable: expect.any(Boolean) });
	});

	test('what cannot be applied is told in its problems, up to a limit, with all counted', async () => {
		const sync = controllerOf({
			bad: `export default async () => Array.from({ length: ${MAX_PROBLEMS + 40} }, (_, i) => ({ url: 'bad' + i }));`,
		});
		const done = await finished(sync, started(sync, 'bad'));
		expect(done.status).toBe('invalid');
		expect(done.problems?.total).toBe(MAX_PROBLEMS + 40);
		expect(done.problems?.listed).toHaveLength(MAX_PROBLEMS);
		expect(done.problems?.listed[0]).toBe(
			'row 1 (bad0): url must be a string that starts with /',
		);
	});

	test('cancel while the script runs ends it as cancelled', async () => {
		const sync = controllerOf({
			slow: 'export default async () => { await new Promise(() => {}); };',
		});
		const id = started(sync, 'slow');
		expect(sync.cancel(id)).toBe(true);
		expect((await finished(sync, id)).status).toBe('cancelled');
		// nothing is left to stop
		expect(sync.cancel(id)).toBe(false);
	});

	test('close stops a script that runs', async () => {
		const sync = controllerOf({
			slow: 'export default async () => { await new Promise(() => {}); };',
		});
		const id = started(sync, 'slow');
		sync.close();
		expect((await finished(sync, id)).status).toBe('cancelled');
	});
});

describe('review and apply', () => {
	const REVIEW = {
		mixed: `export default async () => [
			{ url: '/a/', meta: { title: 'B' } },
			{ url: '/moved/', inputPath: 'b/index.html' },
			{ url: '/n/', virtual: true },
		];`,
	};

	test('tells the counts, and lists the changes by their kind, a page at a time', async () => {
		const sync = controllerOf(REVIEW);
		const id = started(sync, 'mixed');
		const done = await finished(sync, id);
		expect(done.status).toBe('review');
		expect(done.summary).toMatchObject({
			total: 3,
			counts: { added: 1, movedUrl: 1, meta: 1, deleted: 0 },
		});
		expect(sync.changes(id, 'meta', 0, 10)).toEqual({
			total: 1,
			changes: [{ kind: 'meta', url: '/a/', key: 'title', before: '"A"', after: '"B"' }],
		});
		expect(sync.changes(id, 'movedUrl', 0, 10)?.changes).toEqual([
			{ kind: 'movedUrl', from: '/b/', to: '/moved/' },
		]);
		expect(sync.changes(id, 'deleted', 0, 10)).toEqual({ total: 0, changes: [] });
		expect(sync.changes(id, 'nonsense', 0, 10)).toBeNull();
		expect(sync.changes(id, 'meta', 5, 10)).toEqual({ total: 1, changes: [] });
	});

	test('a page of the list is no longer than the limit', async () => {
		const many = Array.from({ length: MAX_CHANGES + 30 }, (_, i) => ({
			url: `/n${i}/`,
			virtual: true,
		}));
		const sync = controllerOf({
			many: `export default async (pages) => [...pages, ...${JSON.stringify(many)}];`,
		});
		const id = started(sync, 'many');
		await finished(sync, id);
		const first = sync.changes(id, 'added', 0, 100_000);
		expect(first?.total).toBe(MAX_CHANGES + 30);
		expect(first?.changes).toHaveLength(MAX_CHANGES);
		expect(sync.changes(id, 'added', MAX_CHANGES, 100_000)?.changes).toHaveLength(30);
		expect(sync.changes(id, 'added', 0, 0)?.changes).toHaveLength(1);
	});

	test('what is shown is made safe, and the paths of the machine are taken out of it', async () => {
		const esc = String.fromCodePoint(27);
		const sync = controllerOf(
			{
				hostile: `export default async () => [
					{ url: '/a/', meta: { title: ${JSON.stringify(`/secret/root${esc}[0m\nfake line`)} } },
					{ url: '/b/' },
				];`,
			},
			(text) => text.replaceAll('/secret/root', '<root>'),
		);
		const id = started(sync, 'hostile');
		await finished(sync, id);
		const [change] = sync.changes(id, 'meta', 0, 10)!.changes;
		expect(change).toMatchObject({ kind: 'meta', url: '/a/', key: 'title' });
		const after = (change as { after: string }).after;
		expect(after).toContain('<root>');
		expect(after).not.toContain(esc);
		expect(after).not.toContain('\n');
	});

	test('names the files that git cannot bring back, a few, and counts them', async () => {
		const sync = controllerOf({ gone: 'export default async () => [];' });
		const id = started(sync, 'gone');
		const done = await finished(sync, id);
		// no repository where the specs run, so git cannot tell
		expect(done.summary).toMatchObject({
			unsaved: { total: 0, listed: [] },
			gitUnavailable: true,
		});
	});

	test('applies what was shown, once, and tells how many edits were made', async () => {
		const sync = controllerOf(REVIEW);
		const id = started(sync, 'mixed');
		await finished(sync, id);
		expect(uiEditBatch).not.toHaveBeenCalled();
		expect(sync.apply(id)).toEqual({ ok: true });
		expect(uiEditBatch).toHaveBeenCalledTimes(1);
		const done = sync.state(id, 0);
		expect(done).toMatchObject({ status: 'applied', applied: { count: 1 } });
		// a second request finds nothing waiting
		expect(sync.apply(id)).toEqual({ ok: false, error: 'notReady' });
		expect(uiEditBatch).toHaveBeenCalledTimes(1);
	});

	test('sends the edits it made, and no edit that a request could carry', async () => {
		const sync = controllerOf(REVIEW);
		const id = started(sync, 'mixed');
		await finished(sync, id);
		sync.apply(id);
		const edits = (JSON.parse(uiEditBatch.mock.calls[0]![1]) as { edits: unknown[] })
			.edits;
		// the edits of the rows of REVIEW: a key of /a/, the move of /b/, a virtual page made
		expect(edits).toEqual([
			{
				url: '/a/',
				expect: { input: 'h:a/index.html', sidecar: null, overrides: 'ov' },
				change: { op: 'set', key: 'title', value: 'B' },
			},
			{
				url: '/b/',
				expect: { input: 'h:b/index.html', sidecar: null, overrides: 'ov' },
				change: { op: 'moveUrl', url: '/moved/' },
			},
			{
				url: '/n/',
				expect: { input: null, sidecar: null, overrides: 'ov' },
				change: { op: 'create', path: null },
			},
		]);
	});

	test('does not apply before the confirmation is asked, or what is not waiting for it', async () => {
		const sync = controllerOf({
			nothing: 'export default async () => null;',
			slow: 'export default async () => { await new Promise(() => {}); };',
		});
		const slow = started(sync, 'slow');
		expect(sync.apply(slow)).toEqual({ ok: false, error: 'notReady' });
		sync.cancel(slow);
		await finished(sync, slow);
		const nothing = started(sync, 'nothing');
		await finished(sync, nothing);
		expect(sync.apply(nothing)).toEqual({ ok: false, error: 'notReady' });
		expect(uiEditBatch).not.toHaveBeenCalled();
	});

	test('a file that changed meanwhile is a conflict, and nothing was applied', async () => {
		uiEditBatch.mockReturnValue(
			JSON.stringify({
				ok: false,
				code: 'conflict',
				message: '/secret/root/a/index.html was changed after it was read',
				errors: [
					{
						index: 0,
						code: 'conflict',
						message: '/secret/root/a/index.html was changed after it was read',
					},
				],
			}),
		);
		const sync = controllerOf(REVIEW, (text) =>
			text.replaceAll('/secret/root', '<root>'),
		);
		const id = started(sync, 'mixed');
		await finished(sync, id);
		sync.apply(id);
		const done = sync.state(id, 0);
		expect(done?.status).toBe('conflict');
		expect(done?.refused?.message).toBe(
			'<root>/a/index.html was changed after it was read',
		);
		expect(done?.refused?.failures.listed[0]).toMatchObject({
			url: expect.any(String),
			op: expect.any(String),
			message: '<root>/a/index.html was changed after it was read',
		});
	});

	test('another refusal of the core is told as refused', async () => {
		uiEditBatch.mockReturnValue(
			JSON.stringify({
				ok: false,
				code: 'collision',
				message: 'a page is already there',
				errors: [{ index: 2, code: 'collision', message: 'a page is already there' }],
			}),
		);
		const sync = controllerOf(REVIEW);
		const id = started(sync, 'mixed');
		await finished(sync, id);
		sync.apply(id);
		expect(sync.state(id, 0)).toMatchObject({
			status: 'refused',
			refused: { code: 'collision', failures: { total: 1 } },
		});
	});
});
