/**
 * The import through `runSync` and `sync`, with a script written as an object (`{ read }`, with
 * no `select` and no `write`): without `select` every page and every key is in the range, so the
 * pages `read` returns are the pages of the site, as the return value of a function was.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const core = {
	uiOpen: vi.fn<(configPath: string, optionsJson: string) => string>(),
	uiServer: vi.fn<(handle: string) => string>(),
	uiRefresh: vi.fn<(handle: string) => string>(),
	uiSyncPages: vi.fn<(handle: string) => string>(),
	uiSyncLocked: vi.fn<(handle: string, query: string) => string>(),
	uiEditBatch: vi.fn<(handle: string, json: string) => string>(),
	uiClose: vi.fn<(handle: string) => string>(),
};

vi.mock('../native.js', () => ({ native: () => core }));

const { runSync, sync, SyncError } = await import('./sync.js');

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'kamado-sync-import-'));
	mkdirSync(path.join(dir, 'scripts'));
});
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

const SNAPSHOT = {
	version: 1,
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
			locked: {},
		},
	],
};

let count = 0;
/**
 * Writes a script.
 * @param body - The module
 */
function script(body: string): string {
	const file = path.join(dir, 'scripts', `s-${count++}.mjs`);
	writeFileSync(file, body);
	return file;
}

const config = path.join(dir ?? '/', 'kamado.config.jsonc');

beforeEach(() => {
	for (const fn of Object.values(core)) {
		fn.mockReset();
	}
	core.uiOpen.mockReturnValue('h1');
	core.uiServer.mockReturnValue(JSON.stringify({ syncFunctions: [] }));
	core.uiSyncPages.mockReturnValue(JSON.stringify(SNAPSHOT));
	core.uiSyncLocked.mockReturnValue('{"version":1,"locked":{}}');
	core.uiEditBatch.mockReturnValue(
		'{"ok":true,"version":2,"overridesHash":"x","count":1}',
	);
	core.uiClose.mockReturnValue('{"warning":null}');
});

/** A script whose `read` gives the pages of the site back as they are. */
const SAME = 'export default { read: async (pages) => pages };';
/** A script whose `read` gives no page: the page of the site is not in the data any more. */
const EMPTY = 'export default { read: async () => [] };';

describe('runSync (import)', () => {
	test('opens the editor of the config with the cache directory, and lets it go', async () => {
		const file = script(SAME);
		await runSync(config, file, { cacheDir: '/cache', write: () => {} });
		expect(core.uiOpen).toHaveBeenCalledWith(
			config,
			JSON.stringify({ cacheDir: '/cache' }),
		);
		expect(core.uiClose).toHaveBeenCalledWith('h1');
		core.uiOpen.mockClear();
		await runSync(config, file, { write: () => {} });
		expect(core.uiOpen).toHaveBeenCalledWith(config, '{}');
	});

	test('lets the editor go when the script fails or the pages cannot be read', async () => {
		await expect(
			runSync(
				config,
				script('export default { read: async () => { throw new Error("x"); } };'),
				{ write: () => {} },
			),
		).rejects.toBeInstanceOf(SyncError);
		expect(core.uiClose).toHaveBeenCalledTimes(1);
		core.uiSyncPages.mockImplementation(() => {
			throw new Error('cannot read the pages');
		});
		await expect(runSync(config, script(SAME), { write: () => {} })).rejects.toThrow(
			'cannot read the pages',
		);
		expect(core.uiClose).toHaveBeenCalledTimes(2);
	});

	test('finds the script of an operation by its name', async () => {
		const file = script('export default { read: async () => ({ not: "an array" }) };');
		core.uiServer.mockReturnValue(
			JSON.stringify({ syncFunctions: [{ name: 'op', label: 'Op', script: file }] }),
		);
		await expect(runSync(config, 'op', { write: () => {} })).rejects.toMatchObject({
			kind: 'failed',
			message: expect.stringContaining('read of the script must return an array'),
		});
	});

	test('writes the log of the script as it is shown, to where it is asked to', async () => {
		const lines: string[] = [];
		await runSync(
			config,
			script(
				'export default { read: async (pages, ctx) => { ctx.log("warn", "line one\\nline two"); return pages; } };',
			),
			{ write: (text) => lines.push(text) },
		);
		expect(lines).toEqual(['[warn] line one\\nline two\n']);
	});

	test.each([
		['nothing', 'export default { read: async () => {} };'],
		['null', 'export default { read: async () => null };'],
	])(
		'a read that returns %s is a failure of the script, and applies nothing',
		async (_name, body) => {
			const error = await runSync(config, script(body), {
				write: () => {},
				yes: true,
			}).catch((error_: unknown) => error_);
			expect(error).toBeInstanceOf(SyncError);
			expect(error).toMatchObject({
				kind: 'failed',
				phase: 'read',
				message: expect.stringContaining('read of the script must return an array'),
			});
			expect(core.uiEditBatch).not.toHaveBeenCalled();
		},
	);

	test('what is the same as the site applies nothing and asks nothing', async () => {
		const confirm = vi.fn(() => true);
		const report = await runSync(config, script(SAME), { write: () => {}, confirm });
		expect(report).toMatchObject({ kind: 'nochange', direction: 'import' });
		expect(confirm).not.toHaveBeenCalled();
		expect(core.uiEditBatch).not.toHaveBeenCalled();
	});

	test('changes that nobody confirms are an error, and nothing is written', async () => {
		const file = script(EMPTY);
		const error = await runSync(config, file, { write: () => {} }).catch(
			(error_: unknown) => error_,
		);
		expect(error).toBeInstanceOf(SyncError);
		expect(error).toMatchObject({ kind: 'unconfirmed' });
		expect((error as InstanceType<typeof SyncError>).message).toContain('yes: true');
		expect((error as InstanceType<typeof SyncError>).summary?.counts.deleted).toBe(1);
		expect(core.uiEditBatch).not.toHaveBeenCalled();
	});

	test('changes that are confirmed are applied', async () => {
		const confirm = vi.fn(() => true);
		const report = await runSync(config, script(EMPTY), { write: () => {}, confirm });
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(report).toMatchObject({ kind: 'applied', direction: 'import', count: 1 });
		expect(core.uiEditBatch).toHaveBeenCalledTimes(1);
	});

	test('does not read the files again when no refresh is asked for', async () => {
		await runSync(config, script(EMPTY), { write: () => {}, yes: true });
		expect(core.uiSyncPages).toHaveBeenCalledTimes(1);
		expect(core.uiRefresh).not.toHaveBeenCalled();
	});

	test('changes that are declined are not applied', async () => {
		const report = await runSync(config, script(EMPTY), {
			write: () => {},
			confirm: () => false,
		});
		expect(report).toMatchObject({ kind: 'declined', direction: 'import' });
		expect(core.uiEditBatch).not.toHaveBeenCalled();
	});

	test('yes applies without asking', async () => {
		const confirm = vi.fn(() => false);
		const report = await runSync(config, script(EMPTY), {
			write: () => {},
			confirm,
			yes: true,
		});
		expect(report).toMatchObject({ kind: 'applied', direction: 'import' });
		expect(confirm).not.toHaveBeenCalled();
	});

	test('an answer of the core that refuses is an error with every failure', async () => {
		core.uiEditBatch.mockReturnValue(
			JSON.stringify({
				ok: false,
				code: 'conflict',
				message: 'changed',
				errors: [{ index: 0, code: 'conflict', message: 'changed' }],
			}),
		);
		const error = await runSync(config, script(EMPTY), {
			write: () => {},
			yes: true,
		}).catch((error_: unknown) => error_);
		expect(error).toMatchObject({
			kind: 'refused',
			message: 'nothing was applied: changed',
			failures: [{ url: '/a/', op: 'deletePage', code: 'conflict', message: 'changed' }],
		});
	});

	test('what the script returned that cannot be applied is told in every problem', async () => {
		const error = await runSync(
			config,
			script('export default { read: async () => [{ url: "no" }, { url: "/n/" }] };'),
			{ write: () => {}, yes: true },
		).catch((error_: unknown) => error_);
		expect(error).toMatchObject({ kind: 'invalid' });
		expect((error as InstanceType<typeof SyncError>).problems).toHaveLength(2);
		expect((error as InstanceType<typeof SyncError>).message).toContain('2 problems');
		expect(core.uiEditBatch).not.toHaveBeenCalled();
	});

	test('a script that fails is an error with its message and its stack', async () => {
		const error = await runSync(
			config,
			script('export default { read: async () => { throw new Error("no network"); } };'),
			{ write: () => {}, yes: true },
		).catch((error_: unknown) => error_);
		expect(error).toMatchObject({
			kind: 'failed',
			message: 'the script failed: no network',
		});
		expect((error as InstanceType<typeof SyncError>).scriptStack).toContain('no network');
		expect(core.uiEditBatch).not.toHaveBeenCalled();
	});

	test('a cancel asked after the script returned is not applied, even with yes', async () => {
		const error = await runSync(config, script(EMPTY), {
			write: () => {},
			yes: true,
			onRun: (run) => {
				void run.done.then(() => run.cancel());
			},
		}).catch((error_: unknown) => error_);
		expect(error).toMatchObject({ kind: 'cancelled' });
		expect(core.uiEditBatch).not.toHaveBeenCalled();
	});

	test('stops only the run of its own when it ends', async () => {
		const slow = script(
			'export default { read: async () => { await new Promise(() => {}); } };',
		);
		let other: { cancel: () => void; done: Promise<unknown> } | undefined;
		const first = runSync(config, slow, {
			write: () => {},
			onRun: (run) => {
				other = run;
			},
		}).catch((error: unknown) => error);
		await vi.waitFor(() => expect(other).toBeDefined());
		// another sync of the same process ends: the first one is not its to stop
		await runSync(config, script(SAME), { write: () => {} });
		let settled = false;
		void other?.done.then(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(settled).toBe(false);
		other?.cancel();
		expect(await first).toMatchObject({ kind: 'cancelled' });
	});

	test('a cancelled run is an error of its own kind', async () => {
		const file = script(
			'export default { read: async () => { await new Promise(() => {}); } };',
		);
		const error = await runSync(config, file, {
			write: () => {},
			onRun: (run) => {
				setTimeout(() => run.cancel(), 20);
			},
		}).catch((error_: unknown) => error_);
		expect(error).toMatchObject({ kind: 'cancelled' });
	});
});

describe('sync (import)', () => {
	test('is applied with yes, and says what the changes were', async () => {
		const outcome = await sync(config, script(EMPTY), { yes: true, write: () => {} });
		expect(outcome.applied).toBe(true);
		expect(outcome.direction).toBe('import');
		expect(outcome.summary.counts.deleted).toBe(1);
	});

	test('a read that returns nothing is a failure, and nothing is applied', async () => {
		await expect(
			sync(config, script('export default { read: async () => null };'), {
				write: () => {},
			}),
		).rejects.toMatchObject({
			kind: 'failed',
			message: expect.stringContaining('read of the script must return an array'),
		});
		expect(core.uiEditBatch).not.toHaveBeenCalled();
	});

	test('applies nothing and says so when the site is what the script returned', async () => {
		const outcome = await sync(config, script(SAME), { write: () => {} });
		expect(outcome).toMatchObject({
			applied: false,
			direction: 'import',
			summary: { changes: [], unsaved: [] },
		});
	});
});
