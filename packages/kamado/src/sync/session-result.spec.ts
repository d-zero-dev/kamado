/**
 * What `prepareSync` makes of a result the child sent that is not the shape the script runner
 * promises. The child is the project's code, so the shape is checked and not taken on trust; the
 * runner is replaced here because a real child always sends a right shape.
 */
import type { Snapshot } from './diff.js';
import type { Run, RunOutcome } from './runner.js';

import { beforeEach, describe, expect, test, vi } from 'vitest';

const cancel = vi.fn();
let outcome: RunOutcome;

vi.mock('./runner.js', () => ({
	runScript: (): Run => ({
		done: Promise.resolve(outcome),
		cancel,
		cancelled: false,
		write: () => Promise.resolve({ kind: 'cancelled' }),
	}),
}));

const { prepareSync } = await import('./session.js');

const SNAPSHOT: Snapshot = {
	version: 1,
	overridesHash: null,
	inputDir: '/site/src',
	outputPathField: null,
	warnings: [],
	pages: [],
};

beforeEach(() => {
	cancel.mockReset();
});

describe('prepareSync, with a result that is not of the right shape', () => {
	test.each([
		[
			'a result that is not an object',
			'text',
			'the script must return an object of select and read',
		],
		[
			'a result that is null',
			null,
			'the script must return an object of select and read',
		],
		[
			'a direction that is neither',
			{ direction: 'sideways', select: null, read: [] },
			'the script must be an import (read) or an export (write)',
		],
		[
			'a select that is not an array',
			{ direction: 'import', select: {}, read: [] },
			'select of the script must return an array of pages',
		],
		[
			'a read that is not an array',
			{ direction: 'import', select: null, read: 'x' },
			'read of the script must return an array of pages',
		],
		[
			'an import without read',
			{ direction: 'import', select: null, read: null },
			'the script must have read to import',
		],
	])('%s fails, and stops the script', async (_name, value, message) => {
		outcome = { kind: 'result', value };
		const prepared = await prepareSync({
			editor: {
				handle: 'h1',
				uiRefresh: vi.fn(),
				uiSyncPages: () => JSON.stringify(SNAPSHOT),
				uiSyncLocked: vi.fn(),
				uiEditBatch: vi.fn(),
			},
			script: '/site/scripts/x.mjs',
			cwd: '/site',
			onLog: () => {},
		});
		expect(prepared).toEqual({ kind: 'failed', message, stack: null });
		expect(cancel).toHaveBeenCalledTimes(1);
	});
});
