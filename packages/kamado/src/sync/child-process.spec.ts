/**
 * `child.ts` as a process of its own, talked to over IPC the way `runner.ts` does: what it does
 * when the parent goes away.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const CHILD = fileURLToPath(new URL('child.ts', import.meta.url));

let dir: string;
const started: ChildProcess[] = [];
beforeAll(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'kamado-sync-child-'));
});
afterAll(() => {
	for (const child of started) {
		child.kill('SIGKILL');
	}
	rmSync(dir, { recursive: true, force: true });
});

let count = 0;
/**
 * Starts the child, asks it to run a script, and waits for its result.
 * @param body - The module of the script
 * @returns The child and what it did when it ended
 */
async function runChild(body: string): Promise<{
	child: ChildProcess;
	exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}> {
	const script = path.join(dir, `script-${count++}.mjs`);
	writeFileSync(script, body);
	const child = fork(CHILD, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
	started.push(child);
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
		(resolve) => {
			child.on('exit', (code, signal) => resolve({ code, signal }));
		},
	);
	const result = new Promise<void>((resolve, reject) => {
		child.on('message', (message: { type?: string }) => {
			if (message.type === 'result') {
				resolve();
			} else if (message.type === 'failure') {
				reject(new Error('the child failed'));
			}
		});
	});
	child.send({
		type: 'run',
		script: pathToFileURL(script).href,
		pages: [],
		inputDir: '/site/src',
	});
	await result;
	return { child, exited };
}

describe('the child process, when the parent goes away', () => {
	test('an export that waits to be asked to write leaves by itself', async () => {
		const { child, exited } = await runChild(
			'export default { read: () => [], write: async () => {} };',
		);
		// It stays while the parent is there: this is what makes the exit below the effect of the disconnect.
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(child.exitCode).toBeNull();
		child.disconnect();
		expect(await exited).toEqual({ code: 0, signal: null });
	});

	test('an import has already left once it sent its result', async () => {
		const { exited } = await runChild('export default { read: () => [] };');
		expect(await exited).toEqual({ code: 0, signal: null });
	});
});
