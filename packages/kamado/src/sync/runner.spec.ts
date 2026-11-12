/* eslint-disable unicorn/no-await-expression-member -- an expectation reads better with the member of what it waits for */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { runScript, type RunOutcome, type ScriptLog } from './runner.js';

let dir: string;

beforeAll(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'kamado-sync-runner-'));
});
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

let count = 0;
/**
 * Writes a script and runs it.
 * @param body
 * @param pages
 */
async function run(
	body: string,
	pages: unknown[] = [],
): Promise<{ outcome: RunOutcome; logs: ScriptLog[] }> {
	const script = path.join(dir, `script-${count++}.mjs`);
	writeFileSync(script, body);
	const logs: ScriptLog[] = [];
	const handle = runScript({
		script,
		pages,
		inputDir: '/site/src',
		onLog: (log) => logs.push(log),
	});
	return { outcome: await handle.done, logs };
}

describe('a script that returns', () => {
	test('an array is a result', async () => {
		const { outcome } = await run(
			'export default async (pages) => pages.map((p) => ({ url: p.url, meta: { n: 1 } }));',
			[{ url: '/a/' }, { url: '/b/' }],
		);
		expect(outcome).toEqual({
			kind: 'result',
			value: [
				{ url: '/a/', meta: { n: 1 } },
				{ url: '/b/', meta: { n: 1 } },
			],
		});
	});

	test('a function that is not async is a script too', async () => {
		const { outcome } = await run('export default () => [{ url: "/x/" }];');
		expect(outcome).toEqual({ kind: 'result', value: [{ url: '/x/' }] });
	});

	test('nothing and null are a result that writes nothing', async () => {
		expect((await run('export default async () => {};')).outcome).toEqual({
			kind: 'result',
			value: null,
		});
		expect((await run('export default async () => null;')).outcome).toEqual({
			kind: 'result',
			value: null,
		});
	});

	test('the script is given the pages, and the directory of the input in ctx', async () => {
		const { outcome } = await run(
			'export default async (pages, ctx) => [{ url: String(pages.length), meta: { dir: ctx.inputDir } }];',
			[1, 2, 3],
		);
		expect(outcome).toEqual({
			kind: 'result',
			value: [{ url: '3', meta: { dir: '/site/src' } }],
		});
	});

	test('a key called __proto__ in the result is an own key, not a prototype', async () => {
		const { outcome } = await run(
			'export default async () => [JSON.parse(\'{"url":"/a/","meta":{"__proto__":{"x":1}}}\')];',
		);
		expect(outcome.kind).toBe('result');
		const value = (outcome as { value: { meta: object }[] }).value[0]!.meta;
		expect(Object.keys(value)).toEqual(['__proto__']);
		expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
	});

	test('the lines it logs arrive in order, before the result', async () => {
		const { outcome, logs } = await run(`export default async (pages, ctx) => {
			ctx.log('info', 'one');
			ctx.log('warn', 'two');
			ctx.log('error', 'three');
			ctx.log('nonsense', 'four');
			return [];
		};`);
		expect(logs).toEqual([
			{ type: 'info', message: 'one' },
			{ type: 'warn', message: 'two' },
			{ type: 'error', message: 'three' },
			{ type: 'info', message: 'four' },
		]);
		expect(outcome).toEqual({ kind: 'result', value: [] });
	});
});

describe('a script that fails (every way is a failure, and none is a result)', () => {
	test('1. a function that throws', async () => {
		const { outcome } = await run(
			'export default async () => { throw new Error("the sheet is closed"); };',
		);
		expect(outcome).toMatchObject({ kind: 'failed', message: 'the sheet is closed' });
		expect((outcome as { stack: string }).stack).toContain('the sheet is closed');
	});

	test('1. a function that throws what is not an Error', async () => {
		const { outcome } = await run('export default async () => { throw "plain text"; };');
		expect(outcome).toEqual({ kind: 'failed', message: 'plain text', stack: null });
		const object = await run('export default async () => { throw { code: 7 }; };');
		expect(object.outcome).toEqual({
			kind: 'failed',
			message: '{"code":7}',
			stack: null,
		});
	});

	test('1. a promise that rejects', async () => {
		const { outcome } = await run(
			'export default () => Promise.reject(new Error("no network"));',
		);
		expect(outcome).toMatchObject({ kind: 'failed', message: 'no network' });
	});

	test('2. an exception nobody caught', async () => {
		const { outcome } = await run(
			'export default async () => { setTimeout(() => { throw new Error("late"); }, 5); await new Promise(() => {}); };',
		);
		expect(outcome).toMatchObject({ kind: 'failed', message: 'late' });
	});

	test('2. a rejection nobody handled', async () => {
		const { outcome } = await run(
			'export default async () => { Promise.reject(new Error("forgotten")); await new Promise(() => {}); };',
		);
		expect(outcome).toMatchObject({ kind: 'failed', message: 'forgotten' });
	});

	test('3. a process that ends before it returns, even with the code 0', async () => {
		const { outcome } = await run('export default async () => { process.exit(0); };');
		expect(outcome).toEqual({
			kind: 'failed',
			message: 'the script ended before it returned (exit code 0)',
			stack: null,
		});
		const other = await run('export default async () => { process.exit(3); };');
		expect(other.outcome).toMatchObject({
			message: 'the script ended before it returned (exit code 3)',
		});
	});

	test('3. a process that is ended by a signal', async () => {
		const { outcome } = await run(
			'export default async () => { process.kill(process.pid, "SIGKILL"); await new Promise(() => {}); };',
		);
		expect(outcome).toEqual({
			kind: 'failed',
			message: 'the script ended before it returned (signal SIGKILL)',
			stack: null,
		});
	});

	test('4. a module that cannot be imported', async () => {
		const missing = await run('import "./nothing-here.mjs"; export default () => [];');
		expect(missing.outcome.kind).toBe('failed');
		const syntax = await run('export default async ( => ;');
		expect(syntax.outcome.kind).toBe('failed');
	});

	test('4. a module whose default export is not a function', async () => {
		const { outcome } = await run('export default { not: "a function" };');
		expect(outcome).toMatchObject({ kind: 'failed' });
		expect((outcome as { message: string }).message).toContain(
			'must export a function by default',
		);
		const none = await run('export const x = 1;');
		expect((none.outcome as { message: string }).message).toContain('missing');
	});

	test('5. a result that is not nothing, null or an array', async () => {
		for (const value of ['"text"', '1', '{ url: "/a/" }', 'true']) {
			const { outcome } = await run(`export default async () => (${value});`);
			expect(outcome.kind, value).toBe('failed');
			expect((outcome as { message: string }).message).toContain('must return');
		}
	});

	test('5. a result that cannot be sent as JSON', async () => {
		const cycle = await run(
			'export default async () => { const a = { url: "/a/" }; a.self = a; return [a]; };',
		);
		expect(cycle.outcome).toMatchObject({ kind: 'failed' });
		expect((cycle.outcome as { message: string }).message).toContain(
			'cannot be sent as JSON',
		);
		const big = await run('export default async () => [{ url: "/a/", n: 10n }];');
		expect(big.outcome.kind).toBe('failed');
	});

	test('a message that is not one of the three is ignored, and the run still ends with the script', async () => {
		const { outcome } = await run(`export default async () => {
			process.send({ type: 'result', json: 5 });
			process.send({ type: 'apply', anything: true });
			process.send('text');
			process.send(null);
			return [{ url: '/ok/' }];
		};`);
		expect(outcome).toEqual({ kind: 'result', value: [{ url: '/ok/' }] });
	});
});

describe('cancel', () => {
	test('stops a script that does not return, and ends the run as cancelled', async () => {
		const script = path.join(dir, `script-${count++}.mjs`);
		writeFileSync(
			script,
			`export default async (pages, ctx) => { ctx.log('info', 'started'); await new Promise(() => {}); };`,
		);
		const logs: ScriptLog[] = [];
		const handle = runScript({
			script,
			pages: [],
			inputDir: '/site/src',
			onLog: (log) => logs.push(log),
		});
		await new Promise<void>((resolve) => {
			const timer = setInterval(() => {
				if (logs.length > 0) {
					clearInterval(timer);
					resolve();
				}
			}, 5);
		});
		handle.cancel();
		expect(await handle.done).toEqual({ kind: 'cancelled' });
		// asked twice, or after the end: nothing changes
		handle.cancel();
		expect(await handle.done).toEqual({ kind: 'cancelled' });
	});

	test('a run that ended is not turned into a cancel', async () => {
		const script = path.join(dir, `script-${count++}.mjs`);
		writeFileSync(script, 'export default async () => [];');
		const handle = runScript({
			script,
			pages: [],
			inputDir: '/site/src',
			onLog: () => {},
		});
		const outcome = await handle.done;
		handle.cancel();
		expect(outcome).toEqual({ kind: 'result', value: [] });
		expect(await handle.done).toEqual({ kind: 'result', value: [] });
	});
});

describe('the process', () => {
	test('is not the one that started the run, and has the environment of the one that did', async () => {
		vi.stubEnv('KAMADO_SYNC_TEST_VALUE', 'from the parent');
		try {
			const { outcome } = await run(
				'export default async () => [{ url: "/p/", meta: { pid: process.pid, env: process.env.KAMADO_SYNC_TEST_VALUE ?? null } }];',
			);
			const meta = (outcome as { value: { meta: { pid: number; env: string | null } }[] })
				.value[0]!.meta;
			expect(meta.pid).not.toBe(process.pid);
			// the script is given what the person's shell gave kamado: this is how a credential reaches it
			expect(meta.env).toBe('from the parent');
		} finally {
			vi.unstubAllEnvs();
		}
	});

	test('runs in the directory it is given, and in that of the one that started it when it is given none', async () => {
		const script = path.join(dir, `script-${count++}.mjs`);
		writeFileSync(
			script,
			'export default async () => [{ url: "/p/", meta: { cwd: process.cwd() } }];',
		);
		const where = async (cwd: string | undefined) => {
			const handle = runScript({
				script,
				pages: [],
				inputDir: '/site/src',
				cwd,
				onLog: () => {},
			});
			const outcome = await handle.done;
			return (outcome as { value: { meta: { cwd: string } }[] }).value[0]!.meta.cwd;
		};
		expect(await where(dir)).toBe(realpathSync(dir));
		expect(await where()).toBe(realpathSync(process.cwd()));
	});

	test('can import files next to it', async () => {
		mkdirSync(path.join(dir, 'lib'), { recursive: true });
		writeFileSync(
			path.join(dir, 'lib', 'rows.mjs'),
			'export const rows = [{ url: "/lib/" }];',
		);
		const { outcome } = await run(
			'import { rows } from "./lib/rows.mjs"; export default async () => rows;',
		);
		expect(outcome).toEqual({ kind: 'result', value: [{ url: '/lib/' }] });
	});
});
