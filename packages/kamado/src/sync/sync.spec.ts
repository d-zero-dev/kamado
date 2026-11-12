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

const { resolveScript, runSync, sync, SyncError, SYNC_OPTION_KEYS, describeCounts } =
	await import('./sync.js');

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'kamado-sync-'));
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
 *
 * @param body
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

describe('resolveScript', () => {
	const functions = [
		{ name: 'import', label: 'Import', script: '/site/scripts/import.mjs' },
		{ name: './odd name', label: 'Odd', script: '/site/scripts/odd.mjs' },
	];

	test('an operation is found by its name', () => {
		expect(resolveScript(functions, 'import', '/anywhere')).toBe(
			'/site/scripts/import.mjs',
		);
	});

	test('a name is looked at before a path, whatever characters it has', () => {
		expect(resolveScript(functions, './odd name', '/anywhere')).toBe(
			'/site/scripts/odd.mjs',
		);
	});

	test('a path is relative to the cwd', () => {
		const file = script('export default () => null;');
		expect(resolveScript([], path.basename(file), path.dirname(file))).toBe(file);
		expect(resolveScript([], file, '/elsewhere')).toBe(file);
	});

	test('a name that is no operation and no file says what there is', () => {
		expect(() => resolveScript(functions, 'nope', dir)).toThrow(
			/no operation named "nope" and no script at .*nope \(ui\.syncFunctions has: import, \.\/odd name\)/u,
		);
		expect(() => resolveScript([], 'nope', dir)).toThrow(
			/ui\.syncFunctions has no operation/u,
		);
	});

	test('a directory is not a script', () => {
		expect(() => resolveScript([], dir, '/')).toThrow(/no script at/u);
	});
});

describe('runSync', () => {
	test('opens the editor of the config with the cache directory, and lets it go', async () => {
		const file = script('export default async () => null;');
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
			runSync(config, script('export default async () => { throw new Error("x"); };'), {
				write: () => {},
			}),
		).rejects.toBeInstanceOf(SyncError);
		expect(core.uiClose).toHaveBeenCalledTimes(1);
		core.uiSyncPages.mockImplementation(() => {
			throw new Error('cannot read the pages');
		});
		await expect(
			runSync(config, script('export default async () => null;'), { write: () => {} }),
		).rejects.toThrow('cannot read the pages');
		expect(core.uiClose).toHaveBeenCalledTimes(2);
	});

	test('finds the script of an operation by its name', async () => {
		const file = script('export default async () => ({ not: "an array" });');
		core.uiServer.mockReturnValue(
			JSON.stringify({ syncFunctions: [{ name: 'op', label: 'Op', script: file }] }),
		);
		await expect(runSync(config, 'op', { write: () => {} })).rejects.toMatchObject({
			kind: 'failed',
		});
	});

	test('writes the log of the script as it is shown, to where it is asked to', async () => {
		const lines: string[] = [];
		await runSync(
			config,
			script(
				'export default async (pages, ctx) => { ctx.log("warn", "line one\\nline two"); return null; };',
			),
			{ write: (text) => lines.push(text) },
		);
		expect(lines).toEqual(['[warn] line one\\nline two\n']);
	});

	test('a script that returns nothing applies nothing', async () => {
		const report = await runSync(config, script('export default async () => {};'), {
			write: () => {},
		});
		expect(report).toEqual({ kind: 'nothing' });
		expect(core.uiEditBatch).not.toHaveBeenCalled();
	});

	test('what is the same as the site applies nothing and asks nothing', async () => {
		const confirm = vi.fn(() => true);
		const report = await runSync(
			config,
			script('export default async (pages) => pages;'),
			{ write: () => {}, confirm },
		);
		expect(report.kind).toBe('nochange');
		expect(confirm).not.toHaveBeenCalled();
		expect(core.uiEditBatch).not.toHaveBeenCalled();
	});

	test('changes that nobody confirms are an error, and nothing is written', async () => {
		const file = script('export default async () => [];');
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
		const report = await runSync(config, script('export default async () => [];'), {
			write: () => {},
			confirm,
		});
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(report).toMatchObject({ kind: 'applied', count: 1 });
		expect(core.uiEditBatch).toHaveBeenCalledTimes(1);
	});

	test('changes that are declined are not applied', async () => {
		const report = await runSync(config, script('export default async () => [];'), {
			write: () => {},
			confirm: () => false,
		});
		expect(report.kind).toBe('declined');
		expect(core.uiEditBatch).not.toHaveBeenCalled();
	});

	test('yes applies without asking', async () => {
		const confirm = vi.fn(() => false);
		const report = await runSync(config, script('export default async () => [];'), {
			write: () => {},
			confirm,
			yes: true,
		});
		expect(report.kind).toBe('applied');
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
		const error = await runSync(config, script('export default async () => [];'), {
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
			script('export default async () => [{ url: "no" }, { url: "/n/" }];'),
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
			script('export default async () => { throw new Error("no network"); };'),
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
		const error = await runSync(config, script('export default async () => [];'), {
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
		const slow = script('export default async () => { await new Promise(() => {}); };');
		let other: { cancel: () => void; done: Promise<unknown> } | undefined;
		const first = runSync(config, slow, {
			write: () => {},
			onRun: (run) => {
				other = run;
			},
		}).catch((error: unknown) => error);
		await vi.waitFor(() => expect(other).toBeDefined());
		// another sync of the same process ends: the first one is not its to stop
		await runSync(config, script('export default async () => null;'), {
			write: () => {},
		});
		let settled = false;
		void other?.done.then(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(settled).toBe(false);
		other?.cancel();
		expect(await first).toMatchObject({ kind: 'cancelled' });
	});

	test('a script path that cannot be looked at is not told as a file that is not there', () => {
		// a name inside a file is not a directory: ENOTDIR is "not there", the rest is the error
		expect(() =>
			resolveScript([], path.join(import.meta.filename, 'x.mjs'), dir),
		).toThrow(/no operation named/u);
	});

	test('a cancelled run is an error of its own kind', async () => {
		const file = script('export default async () => { await new Promise(() => {}); };');
		const error = await runSync(config, file, {
			write: () => {},
			onRun: (run) => {
				setTimeout(() => run.cancel(), 20);
			},
		}).catch((error_: unknown) => error_);
		expect(error).toMatchObject({ kind: 'cancelled' });
	});
});

describe('sync', () => {
	test('is applied with yes, and says what the changes were', async () => {
		const outcome = await sync(config, script('export default async () => [];'), {
			yes: true,
			write: () => {},
		});
		expect(outcome.applied).toBe(true);
		expect(outcome.summary.counts.deleted).toBe(1);
	});

	test('applies nothing and says so when the script returns nothing', async () => {
		const outcome = await sync(config, script('export default async () => null;'), {
			write: () => {},
		});
		expect(outcome).toMatchObject({
			applied: false,
			summary: { changes: [], unsaved: [] },
		});
	});

	test('applies nothing and says so when the site is what the script returned', async () => {
		const outcome = await sync(config, script('export default async (p) => p;'), {
			write: () => {},
		});
		expect(outcome.applied).toBe(false);
	});

	test('refuses a key it does not read', async () => {
		await expect(
			sync(config, 'x', { yse: true } as unknown as Parameters<typeof sync>[2]),
		).rejects.toThrow('unknown option: yse');
		expect(core.uiOpen).not.toHaveBeenCalled();
	});

	test('reads the keys of its options', () => {
		expect([...SYNC_OPTION_KEYS]).toEqual(['yes', 'cacheDir', 'write']);
	});
});

describe('describeCounts', () => {
	test('names what there is and leaves out what there is not', () => {
		expect(
			describeCounts({
				counts: {
					added: 1,
					deleted: 2,
					movedUrl: 0,
					movedFile: 3,
					virtualized: 0,
					materialized: 0,
					meta: 4,
				},
				changes: [],
				unsaved: [],
			}),
		).toBe('1 added, 2 deleted, 3 files moved, 4 keys changed');
	});
});
