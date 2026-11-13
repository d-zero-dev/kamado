/* oxlint-disable unicorn/no-await-expression-member -- an expectation reads better with the member of what it waits for */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { runScript, type Run, type ScriptLog } from './runner.js';

let dir: string;

beforeAll(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'kamado-sync-shapes-'));
});
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

let count = 0;
/**
 * Writes a script and starts it.
 * @param body - The module of the script
 * @param pages - What it is given
 */
function start(
	body: string,
	pages: unknown[] = [],
): { run: Run; logs: ScriptLog[]; waitForLog: (text: string) => Promise<void> } {
	const script = path.join(dir, `script-${count++}.mjs`);
	writeFileSync(script, body);
	const logs: ScriptLog[] = [];
	const run = runScript({
		script,
		pages,
		inputDir: '/site/src',
		onLog: (log) => logs.push(log),
	});
	const waitForLog = async (text: string): Promise<void> => {
		const until = Date.now() + 10_000;
		while (!logs.some((log) => log.message.includes(text))) {
			if (Date.now() > until) {
				throw new Error(`no log line with ${text}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	};
	return { run, logs, waitForLog };
}

describe('the shape of a script', () => {
	test('an import is read: its result says the direction, and that select was left out', async () => {
		const { run } = start(
			'export default { read: async (pages) => pages.map((p) => ({ url: p.url, meta: { n: 1 } })) };',
			[{ url: '/a/' }, { url: '/b/' }],
		);
		expect(await run.done).toEqual({
			kind: 'result',
			value: {
				direction: 'import',
				select: null,
				read: [
					{ url: '/a/', meta: { n: 1 } },
					{ url: '/b/', meta: { n: 1 } },
				],
			},
		});
	});

	test('select and read are both run, and both results are sent', async () => {
		const { run } = start(
			'export default { select: () => [{ url: "/a/" }], read: () => [{ url: "/a/", meta: { t: 1 } }] };',
		);
		expect(await run.done).toEqual({
			kind: 'result',
			value: {
				direction: 'import',
				select: [{ url: '/a/' }],
				read: [{ url: '/a/', meta: { t: 1 } }],
			},
		});
	});

	test('read is given the pages and the directory of the input in ctx, as select is', async () => {
		const { run } = start(
			`export default {
				select: (pages, ctx) => [{ url: String(pages.length), meta: { dir: ctx.inputDir } }],
				read: (pages, ctx) => [{ url: String(pages.length), meta: { dir: ctx.inputDir } }],
			};`,
			[{ url: '/a/' }, { url: '/b/' }, { url: '/c/' }],
		);
		expect(await run.done).toMatchObject({
			kind: 'result',
			value: {
				select: [{ url: '3', meta: { dir: '/site/src' } }],
				read: [{ url: '3', meta: { dir: '/site/src' } }],
			},
		});
	});

	test('a key called __proto__ in what read returns is an own key, not a prototype', async () => {
		const { run } = start(
			'export default { read: () => [JSON.parse(\'{"url":"/a/","meta":{"__proto__":{"x":1}}}\')] };',
		);
		const outcome = await run.done;
		expect(outcome.kind).toBe('result');
		const read = (outcome as { value: { read: { meta: object }[] } }).value.read[0]!.meta;
		expect(Object.keys(read)).toEqual(['__proto__']);
		expect(Object.getPrototypeOf(read)).toBe(Object.prototype);
	});

	test('the lines it logs arrive in order, before the result', async () => {
		const { run, logs } = start(
			`export default { read: async (pages, ctx) => {
				ctx.log('info', 'one');
				ctx.log('warn', 'two');
				ctx.log('nonsense', 'three');
				ctx.log('error', 'four');
				return [];
			} };`,
		);
		expect((await run.done).kind).toBe('result');
		expect(logs).toEqual([
			{ type: 'info', message: 'one' },
			{ type: 'warn', message: 'two' },
			{ type: 'info', message: 'three' },
			{ type: 'error', message: 'four' },
		]);
	});

	test.each([
		[
			'an object with neither read nor write',
			'export default { select: () => [] };',
			'read',
		],
		['a missing default export', 'export const x = 1;', 'missing'],
		['an array', 'export default [];', 'an array'],
		[
			'a read that is not a function',
			'export default { read: 1 };',
			'read of the script must be a function',
		],
		[
			'a write that is not a function',
			'export default { write: "x" };',
			'write of the script must be a function',
		],
		[
			'a select that is not a function',
			'export default { select: [], read: () => [] };',
			'select of the script must be a function',
		],
	])('%s fails', async (_name, body, mention) => {
		const { run } = start(body);
		expect(await run.done).toMatchObject({
			kind: 'failed',
			message: expect.stringContaining(mention),
		});
	});

	test.each([
		['nothing', 'export default { read: async () => {} };', 'returned nothing'],
		['null', 'export default { read: () => null };', 'returned null'],
		['an object', 'export default { read: () => ({ url: "/" }) };', 'returned object'],
		[
			'a select of nothing',
			'export default { select: () => {}, read: () => [] };',
			'select of the script must return an array',
		],
	])('a read or select that returns %s fails', async (_name, body, mention) => {
		const { run } = start(body);
		expect(await run.done).toMatchObject({
			kind: 'failed',
			message: expect.stringContaining(mention),
		});
	});

	test('what cannot be sent as JSON fails, and so does a throw in read, with its stack', async () => {
		const cycle = await start(
			'export default { read: () => { const a = { url: "/a/" }; a.self = a; return [a]; } };',
		).run.done;
		expect(cycle).toMatchObject({
			kind: 'failed',
			message: expect.stringContaining('cannot be sent as JSON'),
		});
		const bigint = await start(
			'export default { read: () => [{ url: "/a/", meta: { n: 10n } }] };',
		).run.done;
		expect(bigint).toMatchObject({
			kind: 'failed',
			message: expect.stringContaining('cannot be sent as JSON'),
		});
		const thrown = await start(
			'export default { read: async () => { throw new Error("the sheet is closed"); } };',
		).run.done;
		expect(thrown).toMatchObject({
			kind: 'failed',
			message: 'the sheet is closed',
			stack: expect.stringContaining('the sheet is closed'),
		});
	});
});

describe('a script that fails', () => {
	test('throws what is not an Error: its text is the message, and there is no stack', async () => {
		const text = await start(
			'export default { read: async () => { throw "plain text"; } };',
		).run.done;
		expect(text).toEqual({ kind: 'failed', message: 'plain text', stack: null });
		const object = await start(
			'export default { read: async () => { throw { code: 7 }; } };',
		).run.done;
		expect(object).toEqual({ kind: 'failed', message: '{"code":7}', stack: null });
	});

	test('rejects with a promise that read returned', async () => {
		const { run } = start(
			'export default { read: () => Promise.reject(new Error("no network")) };',
		);
		expect(await run.done).toMatchObject({ kind: 'failed', message: 'no network' });
	});

	test('throws where nobody catches it, or rejects where nobody handles it', async () => {
		const late = await start(
			'export default { read: async () => { setTimeout(() => { throw new Error("late"); }, 5); await new Promise(() => {}); } };',
		).run.done;
		expect(late).toMatchObject({ kind: 'failed', message: 'late' });
		const forgotten = await start(
			'export default { read: async () => { Promise.reject(new Error("forgotten")); await new Promise(() => {}); } };',
		).run.done;
		expect(forgotten).toMatchObject({ kind: 'failed', message: 'forgotten' });
	});

	test('ends before read returns, even with the code 0', async () => {
		const { run } = start('export default { read: async () => { process.exit(0); } };');
		expect(await run.done).toMatchObject({
			kind: 'failed',
			message: expect.stringContaining(
				'the script ended before it returned (exit code 0)',
			),
		});
		const other = await start(
			'export default { read: async () => { process.exit(3); } };',
		).run.done;
		expect(other).toMatchObject({
			kind: 'failed',
			message: expect.stringContaining('exit code 3'),
		});
	});

	test('is ended by a signal before read returns', async () => {
		const { run } = start(
			'export default { read: async () => { process.kill(process.pid, "SIGKILL"); await new Promise(() => {}); } };',
		);
		expect(await run.done).toMatchObject({
			kind: 'failed',
			message: expect.stringContaining('signal SIGKILL'),
		});
	});

	test('cannot be imported: a missing module, a syntax error', async () => {
		const missing = await start(
			'import "./nothing-here.mjs"; export default { read: () => [] };',
		).run.done;
		expect(missing).toMatchObject({ kind: 'failed' });
		const syntax = await start('export default { read: async ( => ; };').run.done;
		expect(syntax).toMatchObject({ kind: 'failed' });
	});

	test('can import the files next to it', async () => {
		mkdirSync(path.join(dir, 'lib'), { recursive: true });
		writeFileSync(
			path.join(dir, 'lib', 'rows.mjs'),
			'export const rows = [{ url: "/lib/" }];',
		);
		const { run } = start(
			'import { rows } from "./lib/rows.mjs"; export default { read: async () => rows };',
		);
		expect(await run.done).toMatchObject({
			kind: 'result',
			value: { read: [{ url: '/lib/' }] },
		});
	});

	test('sends a message that is not one the parent knows, and the run still ends with the script', async () => {
		const { run } = start(
			`export default { read: async () => {
				process.send({ type: 'bogus' });
				process.send('text');
				process.send(null);
				return [];
			} };`,
		);
		expect(await run.done).toMatchObject({ kind: 'result', value: { read: [] } });
	});

	test('is not turned into a cancel by a cancel that comes after the result', async () => {
		const { run } = start('export default { read: () => [] };');
		const outcome = await run.done;
		run.cancel();
		run.cancel();
		expect(await run.done).toBe(outcome);
		expect(outcome.kind).toBe('result');
		expect(run.cancelled).toBe(true);
	});

	test('a cancel while it runs stops it, and the log it wrote is kept', async () => {
		const { run, logs, waitForLog } = start(
			`export default { read: async (pages, ctx) => { ctx.log('info', 'started'); await new Promise(() => {}); } };`,
		);
		await waitForLog('started');
		run.cancel();
		expect(await run.done).toEqual({ kind: 'cancelled' });
		expect(logs).toEqual([{ type: 'info', message: 'started' }]);
	});
});

describe('an export', () => {
	const EXPORT = `
		let remembered = null;
		export default {
			select: (pages) => pages.map((p) => ({ url: p.url })),
			read: async (pages, ctx) => { remembered = 'learned-in-read'; ctx.log('info', 'read ' + process.pid); return [{ url: '/a/' }]; },
			write: async (input, ctx) => {
				ctx.log('info', 'wrote ' + process.pid + ' ' + remembered + ' ' + JSON.stringify(input));
			},
		};`;

	test('is waiting for the write when its result arrives, and writes in the process that read', async () => {
		const { run, logs } = start(EXPORT, [{ url: '/a/' }, { url: '/b/' }]);
		const outcome = await run.done;
		expect(outcome).toEqual({
			kind: 'result',
			value: {
				direction: 'export',
				select: [{ url: '/a/' }, { url: '/b/' }],
				read: [{ url: '/a/' }],
			},
		});
		expect(await run.write([{ kind: 'added', url: '/b/' }], null)).toEqual({
			kind: 'written',
		});
		const read = logs.find((l) => l.message.startsWith('read '))!.message.split(' ')[1];
		const wrote = logs.find((l) => l.message.startsWith('wrote '))!.message.split(' ');
		expect(wrote[1]).toBe(read);
		expect(wrote[2]).toBe('learned-in-read');
		expect(JSON.parse(wrote.slice(3).join(' '))).toEqual({
			rows: [{ url: '/a/' }, { url: '/b/' }],
			pages: [{ url: '/a/' }, { url: '/b/' }],
			changes: [{ kind: 'added', url: '/b/' }],
		});
	});

	test('is given every page as rows when select was left out, and no changes when nothing was compared', async () => {
		const page = {
			url: '/a/',
			inputPath: '/site/src/a/index.html',
			virtual: false,
			meta: { t: 1 },
			depth: 1,
		};
		const virtual = { url: '/v/', inputPath: null, virtual: true, meta: {}, depth: 1 };
		const { run, logs } = start(
			`export default { write: async (input, ctx) => ctx.log('info', JSON.stringify(input)) };`,
			[page, virtual],
		);
		expect(await run.done).toEqual({
			kind: 'result',
			value: { direction: 'export', select: null, read: null },
		});
		// the rows are made by the parent and sent with the write; pages are the list as it was given
		const rows = [
			{ url: '/a/', inputPath: 'a/index.html', virtual: false, meta: { t: 1 } },
			{ url: '/v/', inputPath: null, virtual: true, meta: {} },
		];
		expect(await run.write(null, rows)).toEqual({ kind: 'written' });
		expect(JSON.parse(logs[0]!.message)).toEqual({ rows, pages: [page, virtual] });
	});

	test('tells the failure of write with its message and its stack', async () => {
		const { run } = start(
			`export default { read: () => [], write: async () => { throw new Error('quota exceeded'); } };`,
		);
		await run.done;
		expect(await run.write(null, null)).toMatchObject({
			kind: 'failed',
			message: 'quota exceeded',
			stack: expect.stringContaining('quota exceeded'),
		});
	});

	test('a cancel while it writes ends the write as cancelled', async () => {
		const { run, waitForLog } = start(
			`export default { read: () => [], write: async (input, ctx) => { ctx.log('info', 'writing'); await new Promise(() => {}); } };`,
		);
		await run.done;
		const written = run.write(null, null);
		await waitForLog('writing');
		run.cancel();
		expect(await written).toEqual({ kind: 'cancelled' });
		expect(run.cancelled).toBe(true);
	});

	test('a cancel while it waits stops it, and a write asked after that is a cancel', async () => {
		const { run } = start(EXPORT);
		await run.done;
		run.cancel();
		expect(await run.write(null, null)).toEqual({ kind: 'cancelled' });
	});

	test('a process that is gone while it waits is told when the write is asked', async () => {
		let told = false;
		const script = path.join(dir, `script-${count++}.mjs`);
		writeFileSync(
			script,
			`export default { read: () => { setTimeout(() => process.kill(process.pid, 'SIGKILL'), 20); return []; }, write: async () => {} };`,
		);
		const run = runScript({
			script,
			pages: [],
			inputDir: '/site/src',
			onLog: () => {},
			onGone: () => {
				told = true;
			},
		});
		await run.done;
		await vi.waitFor(() => expect(told).toBe(true));
		expect(await run.write(null, null)).toMatchObject({
			kind: 'gone',
			message: expect.stringContaining('the script ended before it was asked to write'),
		});
	});

	test('tells at once, when it is gone while it waits, so that what was confirmed is not offered any more', async () => {
		let told: { message: string } | undefined;
		const script = path.join(dir, `script-${count++}.mjs`);
		writeFileSync(
			script,
			`export default { read: () => { setTimeout(() => process.exit(0), 20); return []; }, write: async () => {} };`,
		);
		const run = runScript({
			script,
			pages: [],
			inputDir: '/site/src',
			onLog: () => {},
			onGone: (failure) => {
				told = failure;
			},
		});
		await run.done;
		await vi.waitFor(() => expect(told).toBeDefined());
		expect(told!.message).toContain('the script ended while it waited to write');
	});

	test('a process that ends while it writes is a failure of the write', async () => {
		const { run } = start(
			`export default { read: () => [], write: async () => { process.exit(0); } };`,
		);
		await run.done;
		expect(await run.write(null, null)).toMatchObject({
			kind: 'failed',
			message: expect.stringContaining('the script ended before it finished writing'),
		});
	});

	test('cannot be asked to write before it has returned, nor twice', async () => {
		const { run } = start(
			`export default { read: () => [], write: async () => { await new Promise((r) => setTimeout(r, 200)); } };`,
		);
		expect(await run.write(null, null)).toMatchObject({
			kind: 'failed',
			message: expect.stringContaining('has not returned yet'),
		});
		await run.done;
		const first = run.write(null, null);
		expect(await run.write(null, null)).toMatchObject({
			kind: 'failed',
			message: expect.stringContaining('already writing'),
		});
		expect(await first).toEqual({ kind: 'written' });
	});

	test('an import has nothing to write: its process is not kept', async () => {
		const { run } = start('export default { read: () => [] };');
		await run.done;
		expect(await run.write(null, null)).toEqual({ kind: 'cancelled' });
	});
});
