/**
 * The export through `runSync`, `sync` and `kamado sync`, with a script written as an object
 * (`{ select, read, write }`) that runs in a process of its own: `write` runs only after the
 * confirmation, in the process that read, and that process is gone when the sync ends however it
 * ends.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const { syncCommand } = await import('./command.js');
const { runSync, sync, SyncError } = await import('./sync.js');

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'kamado-sync-export-run-'));
});
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

/**
 * A page of the site.
 * @param stem - Its folder
 * @param title - Its title
 */
function pageOf(stem: string, title: string) {
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
		meta: { title },
		hashes: { input: `h-${stem}`, sidecar: null },
		locked: {},
	};
}

const SNAPSHOT = {
	version: 1,
	overridesHash: 'ov',
	inputDir: '/site/src',
	outputPathField: null,
	warnings: [],
	pages: [pageOf('a', 'A'), pageOf('b', 'B')],
};

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

const config = path.join(dir ?? '/', 'kamado.config.jsonc');

/**
 * A file name, and the code that appends a line to it.
 * @param what - What the line says
 */
function trace(what: string): { file: string; code: string } {
	const file = path.join(dir, `trace-${count++}`);
	return {
		file,
		code: `(await import('node:fs')).appendFileSync(${JSON.stringify(file)}, ${what} + '\\n');`,
	};
}

/**
 * The lines of a file that a script wrote to (none when it did not).
 * @param file - The file of {@link trace}
 */
function linesOf(file: string): string[] {
	return existsSync(file)
		? readFileSync(file, 'utf8')
				.split('\n')
				.filter((line) => line !== '')
		: [];
}

/**
 * Waits until the process whose id a script wrote is gone (signal 0 finds no process).
 * @param file - The file of {@link trace} that has `process.pid`
 */
async function expectStopped(file: string): Promise<void> {
	const pid = Number(linesOf(file)[0]);
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

interface Exporter {
	readonly file: string;
	/** One line per `write` that ran. */
	readonly written: string;
	/** The process id of the script. */
	readonly pid: string;
}

/**
 * An export: `read` gives titles that differ from the site's on both pages, `write` leaves a line.
 * @param options - What differs from the default
 * @param options.read - The code of the value of `read` (default: both titles differ)
 * @param options.hasRead - `false` for a script with no `read`
 * @param options.write - The code of `write` after it left its line
 * @param options.readPrelude - The code that runs in `read` before it returns
 */
function exporter(
	options: {
		read?: string;
		hasRead?: boolean;
		write?: string;
		readPrelude?: string;
	} = {},
): Exporter {
	const written = trace(`'written'`);
	const pid = trace('process.pid');
	const read =
		options.hasRead === false
			? ''
			: `read: async () => { ${pid.code} ${options.readPrelude ?? ''} return ${options.read ?? `[{ url: '/a/', meta: { title: 'x' } }, { url: '/b/', meta: { title: 'y' } }]`}; },`;
	// without read the script runs only to be asked to write: it still tells its process id
	const select =
		options.hasRead === false
			? `select: async (pages) => { ${pid.code} return pages; },`
			: `select: (pages) => pages.map((p) => ({ url: p.url, meta: { title: p.meta.title } })),`;
	const file = script(
		`export default { ${select} ${read} write: async () => { ${written.code} ${options.write ?? ''} } };`,
	);
	return { file, written: written.file, pid: pid.file };
}

beforeEach(() => {
	for (const fn of Object.values(core)) {
		fn.mockReset();
	}
	core.uiOpen.mockReturnValue('h1');
	core.uiServer.mockReturnValue(JSON.stringify({ syncFunctions: [] }));
	core.uiRefresh.mockReturnValue('{"version":1}');
	core.uiSyncPages.mockReturnValue(JSON.stringify(SNAPSHOT));
	core.uiSyncLocked.mockReturnValue('{"version":1,"locked":{}}');
	core.uiEditBatch.mockReturnValue('{"ok":true,"count":1}');
	core.uiClose.mockReturnValue('{"warning":null}');
});

describe('runSync (export)', () => {
	test('yes writes once, in the process that read, and does not touch the files of the site', async () => {
		const out = exporter();
		const confirm = vi.fn(() => false);
		const report = await runSync(config, out.file, {
			write: () => {},
			yes: true,
			confirm,
		});
		expect(report).toMatchObject({ kind: 'applied', direction: 'export', count: 2 });
		expect(confirm).not.toHaveBeenCalled();
		expect(linesOf(out.written)).toEqual(['written']);
		expect(core.uiEditBatch).not.toHaveBeenCalled();
		expect(core.uiClose).toHaveBeenCalledWith('h1');
		await expectStopped(out.pid);
	});

	test('a confirmation that is given asks with what would change outside, and then writes', async () => {
		const out = exporter();
		const confirm = vi.fn(() => {
			expect(linesOf(out.written)).toEqual([]);
			return true;
		});
		const report = await runSync(config, out.file, { write: () => {}, confirm });
		expect(confirm).toHaveBeenCalledWith(
			expect.objectContaining({
				changes: [
					expect.objectContaining({ kind: 'meta', url: '/a/', before: 'x', after: 'A' }),
					expect.objectContaining({ kind: 'meta', url: '/b/', before: 'y', after: 'B' }),
				],
			}),
			{ direction: 'export', diffed: true, targets: 2 },
		);
		expect(report).toMatchObject({ kind: 'applied', direction: 'export', count: 2 });
		expect(linesOf(out.written)).toEqual(['written']);
	});

	test('a confirmation that is declined writes nothing, and the script is stopped', async () => {
		const out = exporter();
		const report = await runSync(config, out.file, {
			write: () => {},
			confirm: () => false,
		});
		expect(report).toMatchObject({ kind: 'declined', direction: 'export' });
		expect(linesOf(out.written)).toEqual([]);
		await expectStopped(out.pid);
	});

	test('a difference that nobody confirms is an error that says nothing was written, and the script is stopped', async () => {
		const out = exporter();
		const error = await runSync(config, out.file, { write: () => {} }).catch(
			(error_: unknown) => error_,
		);
		expect(error).toBeInstanceOf(SyncError);
		expect(error).toMatchObject({ kind: 'unconfirmed' });
		const { message, summary } = error as InstanceType<typeof SyncError>;
		expect(message).toContain('nothing was written');
		expect(message).toContain('yes: true');
		expect(message).toContain('2 keys changed');
		expect(summary?.changes).toHaveLength(2);
		expect(linesOf(out.written)).toEqual([]);
		await expectStopped(out.pid);
	});

	test('a script with no read that nobody confirms says how many pages it would write, and that no difference can be shown', async () => {
		const out = exporter({ hasRead: false });
		const error = await runSync(config, out.file, { write: () => {} }).catch(
			(error_: unknown) => error_,
		);
		expect(error).toMatchObject({ kind: 'unconfirmed' });
		const { message } = error as InstanceType<typeof SyncError>;
		expect(message).toContain('would write 2 pages outside');
		expect(message).toContain('the script has no read');
		expect(message).not.toContain('keys changed');
		expect(linesOf(out.written)).toEqual([]);
		await expectStopped(out.pid);
	});

	test('a script with no read writes after the confirmation, and counts the pages it wrote', async () => {
		const out = exporter({ hasRead: false });
		const confirm = vi.fn(() => true);
		const report = await runSync(config, out.file, { write: () => {}, confirm });
		expect(confirm).toHaveBeenCalledWith(expect.anything(), {
			direction: 'export',
			diffed: false,
			targets: 2,
		});
		expect(report).toMatchObject({ kind: 'applied', direction: 'export', count: 2 });
		expect(linesOf(out.written)).toEqual(['written']);
	});

	test('what is outside being what the site has is no change: nothing is asked, nothing is written, the script is stopped', async () => {
		const out = exporter({
			read: `[{ url: '/a/', meta: { title: 'A' } }, { url: '/b/', meta: { title: 'B' } }]`,
		});
		const confirm = vi.fn(() => true);
		const report = await runSync(config, out.file, { write: () => {}, confirm });
		expect(report).toMatchObject({ kind: 'nochange', direction: 'export' });
		expect(confirm).not.toHaveBeenCalled();
		expect(linesOf(out.written)).toEqual([]);
		await expectStopped(out.pid);
	});

	test('a write that throws is a failure of the phase write, with the message and the stack of the script', async () => {
		const out = exporter({ write: `throw new Error('quota exceeded');` });
		const error = await runSync(config, out.file, {
			write: () => {},
			yes: true,
		}).catch((error_: unknown) => error_);
		expect(error).toBeInstanceOf(SyncError);
		expect(error).toMatchObject({
			kind: 'failed',
			phase: 'write',
			message: expect.stringContaining('quota exceeded'),
		});
		expect((error as InstanceType<typeof SyncError>).scriptStack).toContain(
			'quota exceeded',
		);
		await expectStopped(out.pid);
	});

	test('a cancel while write runs is a cancel of the phase write, and the script is stopped', async () => {
		const out = exporter({ write: `await new Promise(() => {});` });
		const started: { run?: { cancel: () => void } } = {};
		const failed = runSync(config, out.file, {
			write: () => {},
			yes: true,
			onRun: (run) => {
				started.run = run;
			},
		}).catch((error_: unknown) => error_);
		await vi.waitFor(() => expect(linesOf(out.written)).toEqual(['written']));
		started.run!.cancel();
		const error = await failed;
		expect(error).toBeInstanceOf(SyncError);
		expect(error).toMatchObject({ kind: 'cancelled', phase: 'write' });
		await expectStopped(out.pid);
	});

	test('a site that changed while the confirmation was shown is refused with no failure of the core, and nothing is written', async () => {
		const out = exporter();
		const error = await runSync(config, out.file, {
			write: () => {},
			confirm: () => {
				const changed = {
					...SNAPSHOT,
					pages: [
						{ ...SNAPSHOT.pages[0]!, hashes: { input: 'edited', sidecar: null } },
						SNAPSHOT.pages[1]!,
					],
				};
				core.uiSyncPages.mockReturnValue(JSON.stringify(changed));
				return true;
			},
		}).catch((error_: unknown) => error_);
		expect(error).toBeInstanceOf(SyncError);
		expect(error).toMatchObject({
			kind: 'refused',
			failures: [],
			message: expect.stringContaining('changed since the difference was found'),
		});
		expect(linesOf(out.written)).toEqual([]);
		await expectStopped(out.pid);
	});

	test('a script that ended while the confirmation was shown is a failure of the phase read that says nothing was written', async () => {
		const stopFile = path.join(dir, `stop-${count++}`);
		const out = exporter({
			readPrelude: `const fs = await import('node:fs'); setInterval(() => { if (fs.existsSync(${JSON.stringify(stopFile)})) process.exit(0); }, 20);`,
		});
		const error = await runSync(config, out.file, {
			write: () => {},
			confirm: async () => {
				writeFileSync(stopFile, 'stop');
				await expectStopped(out.pid);
				return true;
			},
		}).catch((error_: unknown) => error_);
		expect(error).toBeInstanceOf(SyncError);
		expect(error).toMatchObject({
			kind: 'failed',
			phase: 'read',
			message: expect.stringContaining('nothing was written'),
		});
		expect(linesOf(out.written)).toEqual([]);
	});
});

describe('sync (export)', () => {
	test('is applied with yes, says it is an export, and writes once', async () => {
		const out = exporter();
		const outcome = await sync(config, out.file, { yes: true, write: () => {} });
		expect(outcome).toMatchObject({ applied: true, direction: 'export' });
		expect(outcome.summary.changes).toHaveLength(2);
		expect(linesOf(out.written)).toEqual(['written']);
	});

	test('applies nothing and writes nothing when what is outside is what the site has', async () => {
		const out = exporter({
			read: `[{ url: '/a/', meta: { title: 'A' } }, { url: '/b/', meta: { title: 'B' } }]`,
		});
		const outcome = await sync(config, out.file, { yes: true, write: () => {} });
		expect(outcome).toMatchObject({
			applied: false,
			direction: 'export',
			summary: { changes: [] },
		});
		expect(linesOf(out.written)).toEqual([]);
	});

	test('without yes it is an error, and nothing is written', async () => {
		const out = exporter();
		await expect(sync(config, out.file, { write: () => {} })).rejects.toMatchObject({
			kind: 'unconfirmed',
		});
		expect(linesOf(out.written)).toEqual([]);
	});
});

describe('kamado sync (export)', () => {
	/**
	 * A command context that reaches the real `runSync`, and answers the question.
	 * @param answer - What is typed at the question (`null` for a terminal that cannot be asked)
	 */
	function context(answer: string | null) {
		const out: string[] = [];
		const ask = vi.fn<(question: string) => Promise<string>>(() =>
			Promise.resolve(answer ?? ''),
		);
		return {
			out,
			ask,
			ctx: {
				cwd: dir,
				resolveConfig: () => config,
				write: (text: string) => out.push(text),
				interactive: answer !== null,
				ask,
			},
		};
	}

	test('without a terminal and without --yes it says that it is not a terminal to write on, and writes nothing', async () => {
		const out = exporter();
		const { ctx, ask } = context(null);
		await expect(syncCommand([out.file], {}, ctx)).rejects.toThrow(
			'there is something to write, and nothing was written: this is not a terminal to confirm it on (pass --yes to write it)',
		);
		expect(ask).not.toHaveBeenCalled();
		expect(linesOf(out.written)).toEqual([]);
		await expectStopped(out.pid);
	});

	test('--yes writes without a terminal and tells how many changes it wrote', async () => {
		const out = exporter();
		const { ctx, out: told, ask } = context(null);
		expect(await syncCommand([out.file], { yes: true }, ctx)).toBe(0);
		expect(ask).not.toHaveBeenCalled();
		expect(told.join('')).toContain('Wrote 2 changes outside.');
		expect(linesOf(out.written)).toEqual(['written']);
	});

	test('a yes at the question writes, and tells how many changes it wrote', async () => {
		const out = exporter();
		const { ctx, out: told, ask } = context('y');
		expect(await syncCommand([out.file], {}, ctx)).toBe(0);
		expect(ask).toHaveBeenCalledWith('Write these changes outside? [y/N] ');
		expect(told.join('')).toContain('2 changes to what is outside:');
		expect(told.join('')).toContain('Wrote 2 changes outside.');
		expect(linesOf(out.written)).toEqual(['written']);
	});

	test('a no at the question writes nothing and stops the script', async () => {
		const out = exporter();
		const { ctx, out: told } = context('n');
		expect(await syncCommand([out.file], {}, ctx)).toBe(0);
		expect(told.join('')).toContain('Nothing was written.');
		expect(linesOf(out.written)).toEqual([]);
		await expectStopped(out.pid);
	});

	test('Ctrl-C while the script writes says that what is outside may be half written, and exits with 130', async () => {
		const out = exporter({ write: `await new Promise(() => {});` });
		const { ctx, out: told } = context('y');
		// the listeners of the runner of the tests are not the command's to call
		const others = process.listeners('SIGINT');
		process.removeAllListeners('SIGINT');
		try {
			const exited = syncCommand([out.file], {}, ctx);
			await vi.waitFor(() => expect(linesOf(out.written)).toEqual(['written']));
			process.emit('SIGINT');
			expect(await exited).toBe(130);
		} finally {
			process.removeAllListeners('SIGINT');
			for (const listener of others) {
				process.on('SIGINT', listener);
			}
		}
		expect(told.join('')).toContain(
			'The script was writing: what is outside may be half written. The site was not changed.',
		);
		expect(process.listeners('SIGINT')).toEqual(others);
		await expectStopped(out.pid);
	});

	test('a write that throws says that what is outside may be half written, and exits with 1', async () => {
		const out = exporter({ write: `throw new Error('quota exceeded');` });
		const { ctx, out: told } = context('y');
		expect(await syncCommand([out.file], {}, ctx)).toBe(1);
		expect(told.join('')).toContain('quota exceeded');
		expect(told.join('')).toContain('What is outside may be half written.');
	});
});
