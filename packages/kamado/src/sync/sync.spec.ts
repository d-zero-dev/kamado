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

const { resolveScript, sync, SYNC_OPTION_KEYS, describeCounts } =
	await import('./sync.js');

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'kamado-sync-'));
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

	test('a name that is no operation and no file says what there is', () => {
		expect(() => resolveScript(functions, 'nope', dir)).toThrow(
			/no operation named "nope" and no script at .*nope \(ui\.syncFunctions has: import, \.\/odd name\)/u,
		);
		expect(() => resolveScript([], 'nope', dir)).toThrow(
			/ui\.syncFunctions has no operation/u,
		);
	});

	test('a path is relative to the cwd', () => {
		mkdirSync(path.join(dir, 'sub'), { recursive: true });
		const file = path.join(dir, 'sub', 'import.mjs');
		writeFileSync(file, 'export default { read: async () => [] };');
		expect(resolveScript([], 'sub/import.mjs', dir)).toBe(file);
		expect(resolveScript([], file, '/anywhere')).toBe(file);
	});

	test('a directory is not a script', () => {
		expect(() => resolveScript([], dir, '/')).toThrow(/no script at/u);
	});
});

describe('runSync', () => {
	test('a script path that cannot be looked at is not told as a file that is not there', () => {
		// a name inside a file is not a directory: ENOTDIR is "not there", the rest is the error
		expect(() =>
			resolveScript([], path.join(import.meta.filename, 'x.mjs'), dir),
		).toThrow(/no operation named/u);
	});
});

describe('sync', () => {
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
