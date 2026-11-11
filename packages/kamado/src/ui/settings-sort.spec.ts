import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
	createSettingsStore,
	isSortKey,
	MAX_SORT_KEY,
	parsePatch,
	parseSettings,
} from './settings.js';

const KEY = '/home/u/site/kamado.config.jsonc';

let dir: string;
let file: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'kamado-ui-sort-'));
	file = path.join(dir, 'ui-settings.json');
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('MAX_SORT_KEY', () => {
	test('is the number the screen writes for itself, which it cannot import', async () => {
		const screen = await readFile(
			path.join(import.meta.dirname, '..', '..', 'client', 'src', 'logic', 'sort.ts'),
			'utf8',
		);
		expect(screen).toContain(`export const MAX_SORT_KEY = ${MAX_SORT_KEY};`);
	});
});

describe('isSortKey', () => {
	test('is true for the four kinds of column and false for anything else', () => {
		for (const key of ['url', 'inputPath', 'virtual', 'meta:title', 'meta:a b']) {
			expect(isSortKey(key), key).toBe(true);
		}
		for (const key of ['', 'title', 'meta:', 'outputPath', `meta:${'k'.repeat(300)}`]) {
			// Behavior change: `outputPath` is a column of the screen, so it names a sort
			expect(isSortKey(key), key).toBe(key === 'outputPath');
			// expect(isSortKey(key), key).toBe(false); // previous
		}
	});
});

describe('the sort in a patch', () => {
	test('is kept, with the direction false when it is left out', () => {
		expect(parsePatch({ project: { sort: { key: 'meta:title', desc: true } } })).toEqual({
			project: { sort: { key: 'meta:title', desc: true } },
		});
		expect(parsePatch({ project: { sort: { key: 'url' } } })).toEqual({
			project: { sort: { key: 'url', desc: false } },
		});
	});

	test('can be null, which puts the rows back in the order of the plan', () => {
		expect(parsePatch({ project: { sort: null } })).toEqual({ project: { sort: null } });
	});

	test('is refused when the column or the direction is not one', () => {
		expect(() => parsePatch({ project: { sort: 'url' } })).toThrow('"sort"');
		expect(() => parsePatch({ project: { sort: { key: 'title' } } })).toThrow('"sort"');
		expect(() => parsePatch({ project: { sort: { key: 'url', desc: 'yes' } } })).toThrow(
			'"sort.desc"',
		);
		// A string that spells a boolean is not one.
		expect(() => parsePatch({ project: { sort: { key: 'url', desc: 'true' } } })).toThrow(
			'"sort.desc"',
		);
	});

	test('does not make a project of a patch that holds nothing', () => {
		expect(parsePatch({ project: {} })).toEqual({});
	});
});

describe('the sort in the file', () => {
	test('is read, and a sort that is not one is dropped', () => {
		const text = (sort: unknown) =>
			JSON.stringify({ version: 1, projects: { a: { pageSize: 100, sort } } });
		const read = (sort: unknown) => {
			const parsed = parseSettings(text(sort));
			if (parsed.state !== 'ok') {
				throw new Error(parsed.state);
			}
			return parsed.settings.projects.a;
		};
		expect(read({ key: 'meta:order', desc: true })?.sort).toEqual({
			key: 'meta:order',
			desc: true,
		});
		expect(read({ key: 'nope' })).not.toHaveProperty('sort');
		expect(read('url')).not.toHaveProperty('sort');
	});

	test('is saved with the rest of the project, and null removes it', async () => {
		const store = createSettingsStore(file, KEY);
		await store.update({ project: { pageSize: 100 } });
		const view = await store.update({ project: { sort: { key: 'url', desc: true } } });
		// The page size the project had is kept when only the sort is saved.
		expect(view.project).toMatchObject({
			pageSize: 100,
			sort: { key: 'url', desc: true },
		});
		const written = JSON.parse(await readFile(file, 'utf8')) as {
			projects: Record<string, { sort?: unknown }>;
		};
		expect(written.projects[KEY]?.sort).toEqual({ key: 'url', desc: true });
		const cleared = await store.update({ project: { sort: null } });
		expect(cleared.project).not.toHaveProperty('sort');
		expect(cleared.project?.pageSize).toBe(100);
	});

	test('a page size saved after the sort leaves the sort as it was', async () => {
		const store = createSettingsStore(file, KEY);
		await store.update({ project: { sort: { key: 'meta:title', desc: false } } });
		const view = await store.update({ project: { pageSize: 1000 } });
		expect(view.project?.sort).toEqual({ key: 'meta:title', desc: false });
		expect(view.project?.pageSize).toBe(1000);
	});
});
