/**
 * What `prepareSync` checks right before an export writes: the pages are listed again, and the
 * script is told to write only when the site is what the confirmation showed.
 */
import type { Snapshot } from './diff.js';
import type { Run } from './runner.js';

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { prepareSync, type SyncEditor } from './session.js';

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'kamado-sync-session-export-'));
});
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

const SNAPSHOT: Snapshot = {
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
		},
	],
};

const uiRefresh = vi.fn<SyncEditor['uiRefresh']>();
const uiSyncPages = vi.fn<SyncEditor['uiSyncPages']>();
const editor: SyncEditor = {
	handle: 'h1',
	uiRefresh,
	uiSyncPages,
	uiSyncLocked: vi.fn<SyncEditor['uiSyncLocked']>(),
	uiEditBatch: vi.fn<SyncEditor['uiEditBatch']>(),
};

beforeEach(() => {
	uiRefresh.mockReset().mockReturnValue('{"version":1}');
	uiSyncPages.mockReset().mockReturnValue(JSON.stringify(SNAPSHOT));
});

let count = 0;
/**
 * Prepares an export whose outside has a title that differs, and whose `write` leaves a marker.
 * @returns The review, and the marker file that exists only once `write` ran
 */
async function exportReview() {
	const marker = path.join(dir, `marker-${count++}`);
	const file = path.join(dir, `s-${count++}.mjs`);
	writeFileSync(
		file,
		`export default {
			read: () => [{ url: '/a/', meta: { title: 'Old' } }],
			write: async () => { (await import('node:fs')).writeFileSync(${JSON.stringify(marker)}, 'x'); },
		};`,
	);
	const prepared = await prepareSync({ editor, script: file, cwd: dir, onLog: () => {} });
	if (prepared.kind !== 'review' || prepared.direction !== 'export') {
		throw new Error(`not an export review: ${prepared.kind}`);
	}
	return { prepared, marker };
}

describe('prepareSync (export), when it is asked to write', () => {
	test('writes nothing and says why when the pages cannot be listed again', async () => {
		const { prepared, marker } = await exportReview();
		uiSyncPages.mockImplementation(() => {
			throw new Error('the editor is closed');
		});
		expect(await prepared.write()).toEqual({
			kind: 'notWritten',
			message: 'the pages could not be listed again before writing: the editor is closed',
			stack: null,
		});
		expect(existsSync(marker)).toBe(false);
	});

	test('refuses when the overrides changed, though no page did', async () => {
		const { prepared, marker } = await exportReview();
		uiSyncPages.mockReturnValue(JSON.stringify({ ...SNAPSHOT, overridesHash: 'other' }));
		expect(await prepared.write()).toMatchObject({
			kind: 'conflict',
			message: expect.stringContaining('changed since the difference was found'),
		});
		expect(existsSync(marker)).toBe(false);
	});

	test('stops the script after it refused, so that a second ask is a cancel', async () => {
		const { prepared } = await exportReview();
		uiSyncPages.mockReturnValue(JSON.stringify({ ...SNAPSHOT, overridesHash: 'other' }));
		await prepared.write();
		uiSyncPages.mockReturnValue(JSON.stringify(SNAPSHOT));
		expect(await prepared.write()).toEqual({ kind: 'cancelled' });
	});
});

describe('prepareSync (export), when it throws after the script started', () => {
	test('stops the process that waits to write', async () => {
		const file = path.join(dir, 's-throws.mjs');
		writeFileSync(
			file,
			`export default {
				read: async () => [{ url: '/a/', meta: { title: 'Old' } }],
				write: async () => {},
			};`,
		);
		let started: Run | undefined;
		await expect(
			prepareSync({
				editor,
				script: file,
				cwd: dir,
				onLog: () => {},
				onRun: (run) => {
					started = run;
					throw new Error('onRun failed');
				},
			}),
		).rejects.toThrow('onRun failed');
		// The run that was started is cancelled, not left to wait for a write that nobody will ask for
		// (that the cancel kills the process is the runner's: see `script-shapes.spec.ts`).
		expect(started?.cancelled).toBe(true);
		expect(await started?.write(null, null)).toEqual({ kind: 'cancelled' });
	});
});
