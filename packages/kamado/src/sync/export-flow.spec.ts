import type { Snapshot } from './diff.js';
import type { SyncReport } from './sync.js';

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { summaryText, syncCommand, type SyncCommandContext } from './command.js';
import { allPages } from './compare.js';
import { createSyncController } from './controller.js';
import { prepareSync, type Prepared, type SyncEditor } from './session.js';
import { SyncError } from './sync.js';

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'kamado-sync-export-'));
});
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

/**
 * A page of the site.
 * @param stem - Its folder
 * @param meta - Its metadata
 */
function pageOf(stem: string, meta: Record<string, unknown>) {
	return {
		url: `/${stem}/`,
		inputPath: `/site/src/${stem}/index.html`,
		outputPath: `/site/out/${stem}/index.html`,
		fileSlug: stem,
		filePathStem: `/${stem}/index`,
		extension: '.html',
		depth: 1,
		parent: '/',
		virtual: false,
		meta,
		hashes: { input: `h-${stem}`, sidecar: null },
	};
}

const SNAPSHOT: Snapshot = {
	version: 1,
	overridesHash: null,
	inputDir: '/site/src',
	outputPathField: null,
	warnings: [],
	pages: [pageOf('a', { title: 'A', layout: 'wide' }), pageOf('b', { title: 'B' })],
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
	uiRefresh.mockReset().mockReturnValue('{"version":1}');
	uiSyncPages.mockReset().mockReturnValue(JSON.stringify(SNAPSHOT));
	uiSyncLocked.mockReset().mockReturnValue('{"version":1,"locked":{}}');
	uiEditBatch.mockReset().mockReturnValue('{"ok":true,"count":1}');
});

let count = 0;
/**
 * Writes a script.
 * @param body - The module
 */
function script(body: string): string {
	const file = path.join(dir, `s-${count++}.mjs`);
	writeFileSync(file, body);
	return file;
}

/**
 * A marker file name, and the code that writes it: how a test tells that `write` ran.
 */
function marker(): { file: string; code: string } {
	const file = path.join(dir, `marker-${count++}`);
	return {
		file,
		code: `(await import('node:fs')).writeFileSync(${JSON.stringify(file)}, 'written');`,
	};
}

/**
 * Waits until something holds.
 * @param condition - What to wait for
 */
async function until(condition: () => boolean): Promise<void> {
	const stop = Date.now() + 10_000;
	while (!condition()) {
		if (Date.now() > stop) {
			throw new Error('timed out');
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/**
 * A file the script writes its process id to, and the code that writes it: how a test tells that
 * the process of a script is gone.
 */
function pidProbe(): { file: string; code: string } {
	const file = path.join(dir, `pid-${count++}`);
	return {
		file,
		code: `(await import('node:fs')).appendFileSync(${JSON.stringify(file)}, process.pid + '\\n');`,
	};
}

/**
 * The ids the processes of a script wrote, in the order they ran.
 * @param file - The file of {@link pidProbe}
 */
function pidsOf(file: string): number[] {
	return readFileSync(file, 'utf8')
		.split('\n')
		.filter((line) => line !== '')
		.map(Number);
}

/**
 * Waits until the process whose id a script wrote is gone (signal 0 finds no process).
 * @param file - The file of {@link pidProbe}
 * @param nth - Which of the processes that wrote to it
 */
async function expectStopped(file: string, nth = 0): Promise<void> {
	const pid = pidsOf(file)[nth]!;
	expect(pid).toBeGreaterThan(0);
	await vi.waitFor(
		() => {
			let code: string | undefined;
			try {
				process.kill(pid, 0);
			} catch (error) {
				code = (error as NodeJS.ErrnoException).code;
			}
			expect(code).toBe('ESRCH');
		},
		{ timeout: 10_000, interval: 25 },
	);
}

/**
 * Checks that the process whose id a script wrote is still there.
 * @param file - The file of {@link pidProbe}
 * @param nth - Which of the processes that wrote to it
 */
function expectAlive(file: string, nth = 0): void {
	expect(() => process.kill(pidsOf(file)[nth]!, 0)).not.toThrow();
}

type ReviewOf<D extends 'import' | 'export'> = Extract<
	Prepared,
	{ kind: 'review'; direction: D }
>;

/**
 * The review of an export, with its type narrowed.
 * @param prepared - What `prepareSync` gave
 */
function exportReview(prepared: Prepared): ReviewOf<'export'> {
	if (prepared.kind !== 'review' || prepared.direction !== 'export') {
		throw new Error('not an export review');
	}
	return prepared;
}

/**
 * The review of an import, with its type narrowed.
 * @param prepared - What `prepareSync` gave
 */
function importReview(prepared: Prepared): ReviewOf<'import'> {
	if (prepared.kind !== 'review' || prepared.direction !== 'import') {
		throw new Error('not an import review');
	}
	return prepared;
}

/**
 * The batch of edits the last `uiEditBatch` was given.
 */
function batch(): { url: string; change: { op: string; key?: string } }[] {
	return (JSON.parse(uiEditBatch.mock.calls[0]![1]) as { edits: never[] }).edits;
}

const SELECT_TITLE = `select: (pages) => pages.filter((p) => p.url === '/a/').map((p) => ({ url: p.url, inputPath: p.inputPath, meta: { title: '' } })),`;

describe('an import with select', () => {
	test('applies only what is in the range, and leaves the keys and the pages out of it', async () => {
		const prepared = await prepareSync({
			editor,
			script: script(
				`export default { ${SELECT_TITLE} read: () => [{ url: '/a/', inputPath: 'a/index.html', meta: { title: 'New' } }] };`,
			),
			cwd: dir,
			onLog: () => {},
		});
		const review = importReview(prepared);
		expect(review.summary.changes).toEqual([
			{ kind: 'meta', url: '/a/', key: 'title', before: 'A', after: 'New' },
		]);
		review.apply();
		expect(batch()).toEqual([
			{
				url: '/a/',
				expect: expect.anything(),
				change: { op: 'set', key: 'title', value: 'New' },
			},
		]);
	});

	test('is no change once the site is what read gives (nothing else of the page is asked about)', async () => {
		const prepared = await prepareSync({
			editor,
			script: script(
				`export default { ${SELECT_TITLE} read: () => [{ url: '/a/', inputPath: 'a/index.html', meta: { title: 'A' } }] };`,
			),
			cwd: dir,
			onLog: () => {},
		});
		expect(prepared).toMatchObject({ kind: 'nochange', direction: 'import' });
	});

	test('what read returns outside the range is told as a problem, and nothing is applied', async () => {
		const prepared = await prepareSync({
			editor,
			script: script(
				`export default { ${SELECT_TITLE} read: () => [{ url: '/a/', inputPath: 'a/index.html' }, { url: '/b/', inputPath: 'b/index.html' }] };`,
			),
			cwd: dir,
			onLog: () => {},
		});
		expect(prepared).toMatchObject({
			kind: 'invalid',
			problems: [{ row: 2, url: '/b/' }],
		});
		expect(uiEditBatch).not.toHaveBeenCalled();
	});
});

describe('an export through prepareSync', () => {
	/**
	 * An export that writes a marker, and returns what the outside has.
	 * @param read - The code of `read`'s body
	 * @param extra - More members of the script
	 */
	function exporter(read: string, extra = '') {
		const written = marker();
		const pid = pidProbe();
		const file = script(
			`export default { select: (pages) => pages.map((p) => ({ url: p.url, meta: { title: p.meta.title } })), read: async () => { ${pid.code} return ${read}; }, write: async () => { ${written.code} }, ${extra} };`,
		);
		return { file, written, pid };
	}

	/**
	 * Prepares it.
	 * @param file - The script
	 */
	function prepare(file: string) {
		return prepareSync({ editor, script: file, cwd: dir, onLog: () => {} });
	}

	test('shows what would change outside, writes nothing before it is confirmed, and writes after', async () => {
		const { file, written } = exporter(`[{ url: '/a/', meta: { title: 'Old' } }]`);
		const prepared = exportReview(await prepare(file));
		expect(prepared).toMatchObject({
			kind: 'review',
			direction: 'export',
			diffed: true,
			targets: 2,
		});
		expect(prepared.summary.changes).toEqual([
			{ kind: 'added', url: '/b/', virtual: false, inputPath: null, keys: 1 },
			{ kind: 'meta', url: '/a/', key: 'title', before: 'Old', after: 'A' },
		]);
		expect(prepared.summary.unsaved).toEqual([]);
		expect(existsSync(written.file)).toBe(false);
		expect(uiEditBatch).not.toHaveBeenCalled();
		expect(await prepared.write()).toEqual({ kind: 'written', count: 2 });
		expect(existsSync(written.file)).toBe(true);
		expect(uiEditBatch).not.toHaveBeenCalled();
	});

	test('is no change, and the script is stopped, when the outside is what the site is', async () => {
		const { file, pid } = exporter(
			`[{ url: '/a/', meta: { title: 'A' } }, { url: '/b/', meta: { title: 'B' } }]`,
		);
		expect(await prepare(file)).toMatchObject({ kind: 'nochange', direction: 'export' });
		await expectStopped(pid.file);
	});

	test('without read it asks only whether to write, and says how many pages it would write', async () => {
		const written = marker();
		const prepared = exportReview(
			await prepare(script(`export default { write: async () => { ${written.code} } };`)),
		);
		expect(prepared).toMatchObject({
			diffed: false,
			targets: 2,
			summary: { changes: [] },
		});
		expect(existsSync(written.file)).toBe(false);
		expect(await prepared.write()).toEqual({ kind: 'written', count: 2 });
		expect(existsSync(written.file)).toBe(true);
	});

	test('refuses to write, and writes nothing, when the pages of the site changed while it waited', async () => {
		const { file, written } = exporter(`[{ url: '/a/', meta: { title: 'Old' } }]`);
		const prepared = exportReview(await prepare(file));
		const changed: Snapshot = {
			...SNAPSHOT,
			pages: [
				{ ...SNAPSHOT.pages[0]!, hashes: { input: 'edited', sidecar: null } },
				SNAPSHOT.pages[1]!,
			],
		};
		uiSyncPages.mockReturnValue(JSON.stringify(changed));
		expect(await prepared.write()).toMatchObject({
			kind: 'conflict',
			message: expect.stringContaining('changed since the difference was found'),
		});
		expect(uiRefresh).toHaveBeenCalled();
		expect(existsSync(written.file)).toBe(false);
	});

	test('is told as failed, with the stack, when write throws', async () => {
		const prepared = exportReview(
			await prepare(
				script(
					`export default { read: () => [], write: async () => { throw new Error('quota exceeded'); } };`,
				),
			),
		);
		expect(await prepared.write()).toMatchObject({
			kind: 'failed',
			message: 'quota exceeded',
			stack: expect.stringContaining('quota exceeded'),
		});
	});

	test('discarding it stops the script, so that a write asked after is a cancel', async () => {
		const { file, written, pid } = exporter(`[]`);
		const prepared = exportReview(await prepare(file));
		expectAlive(pid.file);
		prepared.discard();
		await expectStopped(pid.file);
		expect(await prepared.write()).toEqual({ kind: 'cancelled' });
		expect(existsSync(written.file)).toBe(false);
	});

	test('gives write the rows that were compared: the same as every page of the site when select is left out', async () => {
		const rows = path.join(dir, `rows-${count++}.json`);
		const prepared = exportReview(
			await prepare(
				script(
					`import { writeFileSync } from 'node:fs';
					export default {
						read: async () => [],
						write: async ({ rows }) => { writeFileSync(${JSON.stringify(rows)}, JSON.stringify(rows)); },
					};`,
				),
			),
		);
		expect(await prepared.write()).toMatchObject({ kind: 'written' });
		expect(JSON.parse(readFileSync(rows, 'utf8'))).toEqual(allPages(SNAPSHOT));
	});

	test('tells that the script is gone, and that nothing was written, when it died while it waited', async () => {
		const written = marker();
		const gone: { message?: string }[] = [];
		const stopFile = path.join(dir, `stop-${count++}`);
		const prepared = exportReview(
			await prepareSync({
				editor,
				script: script(
					`export default {
						read: async () => {
							const fs = await import('node:fs');
							setInterval(() => { if (fs.existsSync(${JSON.stringify(stopFile)})) process.exit(0); }, 20);
							return [];
						},
						write: async () => { ${written.code} },
					};`,
				),
				cwd: dir,
				onLog: () => {},
				onGone: (failure) => gone.push(failure),
			}),
		);
		writeFileSync(stopFile, 'stop');
		await until(() => gone.length > 0);
		expect(gone[0]!.message).toContain('the script ended while it waited to write');
		expect(await prepared.write()).toMatchObject({
			kind: 'notWritten',
			message: expect.stringContaining('the script ended before it was asked to write'),
		});
		expect(existsSync(written.file)).toBe(false);
	});

	test('tells the problems of what read returns, and stops the script', async () => {
		const { file, pid } = exporter(`[{ url: 'no-slash' }]`);
		expect(await prepare(file)).toMatchObject({
			kind: 'invalid',
			problems: [{ row: 1, message: expect.stringContaining('row 1 (no-slash)') }],
		});
		await expectStopped(pid.file);
	});
});

describe('an export through the controller of the screen', () => {
	/**
	 * A controller with one operation.
	 * @param file - The script of the operation
	 */
	function controllerOf(file: string) {
		return createSyncController({
			editor,
			functions: [{ name: 'out', label: 'Out', script: file }],
			cwd: dir,
			scrub: (text) => text,
		});
	}

	const SLOW_WRITE = (code: string, readCode = '') =>
		`export default { read: async () => { ${readCode} return []; }, write: async (input, ctx) => { ctx.log('info', 'writing'); ${code} await new Promise((r) => setTimeout(r, 400)); } };`;

	test('is a review that says the way and the range, then writing, then applied', async () => {
		const written = marker();
		const sync = controllerOf(script(SLOW_WRITE(written.code)));
		const started = sync.run('out');
		if (!started.ok) {
			throw new Error('not started');
		}
		await until(() => sync.state(started.id, 0)?.status !== 'running');
		expect(sync.state(started.id, 0)).toMatchObject({
			status: 'review',
			direction: 'export',
			diffed: true,
			targets: 2,
		});
		expect(sync.apply(started.id)).toEqual({ ok: true });
		expect(sync.state(started.id, 0)?.status).toBe('writing');
		// a sync that writes is not one that another may start
		expect(sync.run('out')).toEqual({ ok: false, error: 'busy' });
		await until(() => sync.state(started.id, 0)?.status !== 'writing');
		expect(sync.state(started.id, 0)).toMatchObject({
			status: 'applied',
			direction: 'export',
			applied: { count: 2 },
		});
		expect(existsSync(written.file)).toBe(true);
		expect(uiEditBatch).not.toHaveBeenCalled();
	});

	test('a cancel while it writes says that what is outside may be half written', async () => {
		const sync = controllerOf(script(SLOW_WRITE('')));
		const started = sync.run('out');
		if (!started.ok) {
			throw new Error('not started');
		}
		await until(() => sync.state(started.id, 0)?.status === 'review');
		sync.apply(started.id);
		await until(() => (sync.state(started.id, 0)?.log.length ?? 0) > 0);
		expect(sync.cancel(started.id)).toBe(true);
		await until(() => sync.state(started.id, 0)?.status !== 'writing');
		expect(sync.state(started.id, 0)).toMatchObject({
			status: 'cancelled',
			phase: 'write',
		});
	});

	test('a failure of write is told as one of the phase write', async () => {
		const sync = controllerOf(
			script(
				`export default { read: () => [], write: async () => { throw new Error('quota exceeded'); } };`,
			),
		);
		const started = sync.run('out');
		if (!started.ok) {
			throw new Error('not started');
		}
		await until(() => sync.state(started.id, 0)?.status === 'review');
		sync.apply(started.id);
		await until(() => sync.state(started.id, 0)?.status !== 'writing');
		expect(sync.state(started.id, 0)).toMatchObject({
			status: 'failed',
			phase: 'write',
			failure: { message: 'quota exceeded' },
		});
	});

	test('a script that dies while the confirmation is shown fails the sync at once, and nothing is written', async () => {
		const written = marker();
		const stopFile = path.join(dir, `stop-${count++}`);
		const sync = controllerOf(
			script(
				`export default {
					select: (pages) => pages.map((p) => ({ url: p.url, meta: { title: 'new' } })),
					read: async () => {
						const fs = await import('node:fs');
						setInterval(() => { if (fs.existsSync(${JSON.stringify(stopFile)})) process.exit(0); }, 20);
						return [{ url: '/a/', meta: { title: 'old' } }];
					},
					write: async () => { ${written.code} },
				};`,
			),
		);
		const started = sync.run('out');
		if (!started.ok) {
			throw new Error('not started');
		}
		await until(() => sync.state(started.id, 0)?.status === 'review');
		writeFileSync(stopFile, 'stop');
		await until(() => sync.state(started.id, 0)?.status === 'failed');
		expect(sync.state(started.id, 0)).toMatchObject({
			status: 'failed',
			phase: 'read',
			failure: {
				message: expect.stringContaining('the script ended while it waited to write'),
			},
		});
		expect(sync.apply(started.id)).toEqual({ ok: false, error: 'notReady' });
		expect(existsSync(written.file)).toBe(false);
	});

	test('a failure of read is the phase read', async () => {
		const sync = controllerOf(
			script(`export default { read: () => { throw new Error('no sheet'); } };`),
		);
		const started = sync.run('out');
		if (!started.ok) {
			throw new Error('not started');
		}
		await until(() => sync.state(started.id, 0)?.status !== 'running');
		expect(sync.state(started.id, 0)).toMatchObject({ status: 'failed', phase: 'read' });
	});

	test('a cancel at the confirmation drops it and stops the script that waits', async () => {
		const written = marker();
		const pid = pidProbe();
		const sync = controllerOf(script(SLOW_WRITE(written.code, pid.code)));
		const started = sync.run('out');
		if (!started.ok) {
			throw new Error('not started');
		}
		await until(() => sync.state(started.id, 0)?.status === 'review');
		expectAlive(pid.file);
		expect(sync.cancel(started.id)).toBe(true);
		expect(sync.state(started.id, 0)?.status).toBe('cancelled');
		expect(sync.apply(started.id)).toEqual({ ok: false, error: 'notReady' });
		await expectStopped(pid.file);
		expect(existsSync(written.file)).toBe(false);
	});

	test('a new run drops a confirmation that was left, and stops the script that waited', async () => {
		const written = marker();
		const pid = pidProbe();
		const sync = controllerOf(script(SLOW_WRITE(written.code, pid.code)));
		const first = sync.run('out');
		if (!first.ok) {
			throw new Error('not started');
		}
		await until(() => sync.state(first.id, 0)?.status === 'review');
		expectAlive(pid.file, 0);
		const second = sync.run('out');
		if (!second.ok) {
			throw new Error('not started');
		}
		expect(sync.apply(first.id)).toEqual({ ok: false, error: 'unknown' });
		await until(() => sync.state(second.id, 0)?.status === 'review');
		expect(pidsOf(pid.file)).toHaveLength(2);
		await expectStopped(pid.file, 0);
		// only the first is stopped: the confirmation of the new run is still there
		expectAlive(pid.file, 1);
		sync.close();
		await expectStopped(pid.file, 1);
		expect(existsSync(written.file)).toBe(false);
	});

	test('closing the controller stops the script of a confirmation that is shown', async () => {
		const written = marker();
		const pid = pidProbe();
		const sync = controllerOf(script(SLOW_WRITE(written.code, pid.code)));
		const started = sync.run('out');
		if (!started.ok) {
			throw new Error('not started');
		}
		await until(() => sync.state(started.id, 0)?.status === 'review');
		expectAlive(pid.file);
		sync.close();
		await expectStopped(pid.file);
		expect(existsSync(written.file)).toBe(false);
	});
});

describe('kamado sync of an export', () => {
	/**
	 * A command context that answers a question with a fixed answer.
	 * @param answer - What is typed at the question
	 * @param report - What the run gives
	 */
	function context(answer: string, report: SyncReport | SyncError) {
		const out: string[] = [];
		const ask = vi.fn(() => Promise.resolve(answer));
		const ctx: SyncCommandContext = {
			cwd: '/site',
			resolveConfig: () => '/site/kamado.config.jsonc',
			write: (text) => out.push(text),
			interactive: true,
			ask,
			run: async (_config, _target, options) => {
				if (report instanceof SyncError) {
					throw report;
				}
				await options.confirm?.(SUMMARY, {
					direction: 'export',
					diffed: true,
					targets: 2,
				});
				return report;
			},
		};
		return { ctx, out, ask };
	}

	const SUMMARY = {
		counts: {
			added: 1,
			deleted: 0,
			movedUrl: 0,
			movedFile: 0,
			virtualized: 0,
			materialized: 0,
			meta: 0,
		},
		changes: [{ kind: 'added', url: '/b/', virtual: false, inputPath: null, keys: 0 }],
		unsaved: [],
	} as const;

	test('says the changes are to what is outside, and asks whether to write them', async () => {
		const { ctx, out, ask } = context('y', {
			kind: 'applied',
			direction: 'export',
			summary: SUMMARY,
			count: 1,
		});
		expect(await syncCommand(['sheet'], {}, ctx)).toBe(0);
		expect(out.join('')).toContain('1 change to what is outside:');
		expect(ask).toHaveBeenCalledWith('Write these changes outside? [y/N] ');
		expect(out.join('')).toContain('Wrote 1 change outside.');
	});

	test('summaryText of an export without read says the count and that no difference can be shown', () => {
		expect(
			summaryText(
				{ ...SUMMARY, counts: { ...SUMMARY.counts, added: 0 }, changes: [] },
				{ direction: 'export', diffed: false, targets: 3 },
			),
		).toBe(
			'The script would write 3 pages outside. No difference can be shown: the script has no read.\n',
		);
	});

	test('says nothing was written when it is declined, and when what is outside is the same', async () => {
		const declined = context('n', {
			kind: 'declined',
			direction: 'export',
			summary: SUMMARY,
		});
		expect(await syncCommand(['sheet'], {}, declined.ctx)).toBe(0);
		expect(declined.out.join('')).toContain('Nothing was written.');
		const same = context('y', {
			kind: 'nochange',
			direction: 'export',
			summary: SUMMARY,
		});
		expect(await syncCommand(['sheet'], {}, same.ctx)).toBe(0);
		expect(same.out.join('')).toContain(
			'No changes: what is outside is what the site has.',
		);
	});

	test('tells that what is outside may be half written, when write failed', async () => {
		const { ctx, out } = context(
			'y',
			new SyncError('failed', 'the script failed while writing: quota exceeded', {
				scriptStack: 'Error: quota exceeded\n    at write (s.mjs:1:1)',
				phase: 'write',
			}),
		);
		expect(await syncCommand(['sheet'], {}, ctx)).toBe(1);
		expect(out.join('')).toContain('What is outside may be half written.');
		expect(out.join('')).toContain('The site was not changed');
	});
});
