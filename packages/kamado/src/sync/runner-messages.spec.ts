/**
 * What `runner.ts` makes of messages and channels that a real script never produces, with a
 * child process that is a stand-in for `child.ts` (`RunRequest.childFile`).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { runScript } from './runner.js';

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'kamado-sync-runner-messages-'));
});
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

let count = 0;
/**
 * Starts a run whose child process is the given program.
 * @param childBody - What the stand-in child does when it is asked to run
 */
function runWith(childBody: string) {
	const childFile = path.join(dir, `child-${count++}.mjs`);
	writeFileSync(childFile, `process.on('message', (message) => {\n${childBody}\n});`);
	return runScript({
		script: path.join(dir, 'unused.mjs'),
		pages: [],
		inputDir: '/site/src',
		onLog: () => {},
		childFile,
	});
}

describe('what the result of the child is', () => {
	test('a result that is not JSON is a failure that says so', async () => {
		const run = runWith(
			`if (message.type === 'run') { process.send({ type: 'result', json: '{broken' }); }
			setInterval(() => {}, 1000);`,
		);
		expect(await run.done).toMatchObject({
			kind: 'failed',
			message: expect.stringContaining('what the script returned is not JSON'),
		});
	});

	test('a result whose json is not text is not a result: the run ends with the process', async () => {
		const run = runWith(
			`if (message.type === 'run') { process.send({ type: 'result', json: { direction: 'import' } }); process.exit(0); }`,
		);
		expect(await run.done).toMatchObject({
			kind: 'failed',
			message: expect.stringContaining('the script ended before it returned'),
		});
	});
});

describe('the channel to the child', () => {
	test('changes that cannot be sent end the write as a failure', async () => {
		// The child closes its end of the channel after the result but stays alive, so the run is
		// not gone (it is waiting for the process to exit as well) and the send itself fails.
		const run = runWith(
			`if (message.type === 'run') {
				process.send(
					{ type: 'result', json: JSON.stringify({ direction: 'export', select: null, read: null }) },
					() => process.disconnect(),
				);
			}
			setInterval(() => {}, 1000);`,
		);
		expect(await run.done).toMatchObject({ kind: 'result' });
		expect(await run.write(null, null)).toMatchObject({
			kind: 'failed',
			message: expect.stringContaining('the changes could not be sent to the script'),
		});
	});
});
