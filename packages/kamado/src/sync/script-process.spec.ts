import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { runScript, type RunOutcome, type ScriptLog } from './runner.js';

let dir: string;

beforeAll(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'kamado-sync-process-'));
});
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

let count = 0;
/**
 * Writes a script and runs it.
 * @param body - The module of the script
 */
async function run(body: string): Promise<RunOutcome> {
	const script = path.join(dir, `script-${count++}.mjs`);
	writeFileSync(script, body);
	const handle = runScript({
		script,
		pages: [],
		inputDir: '/site/src',
		onLog: () => {},
	});
	return handle.done;
}

/**
 * The meta of the first page that read returned.
 * @param outcome - What the run ended with
 */
function metaOf(outcome: RunOutcome): Record<string, unknown> {
	if (outcome.kind !== 'result') {
		throw new Error(`the run did not return: ${JSON.stringify(outcome)}`);
	}
	const { read } = outcome.value as { read: { meta: Record<string, unknown> }[] };
	return read[0]!.meta;
}

describe('the process of a script', () => {
	test('is not the one that started the run, and has the environment of the one that did', async () => {
		vi.stubEnv('KAMADO_SYNC_TEST_VALUE', 'from the parent');
		try {
			const meta = metaOf(
				await run(
					'export default { read: async () => [{ url: "/p/", meta: { pid: process.pid, env: process.env.KAMADO_SYNC_TEST_VALUE ?? null } }] };',
				),
			);
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
			'export default { read: async () => [{ url: "/p/", meta: { cwd: process.cwd() } }] };',
		);
		const where = async (cwd: string | undefined) => {
			const handle = runScript({
				script,
				pages: [],
				inputDir: '/site/src',
				cwd,
				onLog: () => {},
			});
			return metaOf(await handle.done).cwd;
		};
		expect(await where(dir)).toBe(realpathSync(dir));
		expect(await where()).toBe(realpathSync(process.cwd()));
	});
});

describe('cancel (a script of read)', () => {
	test('stops a script that does not return, and ends the run as cancelled', async () => {
		const script = path.join(dir, `script-${count++}.mjs`);
		writeFileSync(
			script,
			`export default { read: async (pages, ctx) => { ctx.log('info', 'started'); await new Promise(() => {}); } };`,
		);
		const logs: ScriptLog[] = [];
		const handle = runScript({
			script,
			pages: [],
			inputDir: '/site/src',
			onLog: (log) => logs.push(log),
		});
		await vi.waitFor(() => expect(logs.length).toBeGreaterThan(0), { timeout: 10_000 });
		handle.cancel();
		expect(await handle.done).toEqual({ kind: 'cancelled' });
		// asked twice, or after the end: nothing changes
		handle.cancel();
		expect(await handle.done).toEqual({ kind: 'cancelled' });
	});
});
