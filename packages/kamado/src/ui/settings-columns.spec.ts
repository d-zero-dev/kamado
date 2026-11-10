import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import * as screen from '../../client/src/logic/layout.js';

import {
	createSettingsStore,
	MAX_COLUMN_WIDTH,
	MAX_COLUMNS,
	MIN_COLUMN_WIDTH,
	parsePatch,
	parseSettings,
} from './settings.js';

const KEY = '/home/u/site/kamado.config.jsonc';

let dir: string;
let file: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'kamado-ui-columns-'));
	file = path.join(dir, 'ui-settings.json');
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('the screen and the server', () => {
	test('have the same limits (the screen cannot import this module, so it writes them again)', () => {
		expect([
			screen.MIN_COLUMN_WIDTH,
			screen.MAX_COLUMN_WIDTH,
			screen.MAX_COLUMNS,
		]).toEqual([MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH, MAX_COLUMNS]);
	});

	test('the server takes every layout the screen makes, whatever the keys of the site are', () => {
		const sites = [
			[],
			['a', 'b'],
			// An empty key and a key that is too long are columns the server cannot name.
			['', 'k'.repeat(300), 'title'],
			Array.from({ length: MAX_COLUMNS + 50 }, (_, n) => `key${n}`),
			// Keys as long as a key may be: the layout must still fit the body of a change.
			Array.from({ length: MAX_COLUMNS }, (_, n) => `${'k'.repeat(240)}${n}`),
		];
		for (const keys of sites) {
			const known = screen.columnIds(keys);
			let state = screen.resizeColumn(screen.emptyLayout(), 'url', 300);
			state = screen.resizeColumn(state, 'meta:', 100);
			state = screen.pinColumn(state, known, known.at(-1) ?? 'url');
			state = screen.moveColumn(state, known, 'virtual', 1);
			const unpinned = screen.unpinColumn(state, known, 'url');
			for (const next of [state, unpinned]) {
				const body = JSON.stringify({
					project: { columns: screen.settingsOf(next, known) },
				});
				// The body of a change of the settings may be 64 KiB (`MAX_SETTINGS_BODY` of `app.ts`).
				expect(new TextEncoder().encode(body).length, `${keys.length} keys`).toBeLessThan(
					64 * 1024,
				);
				expect(
					() => parsePatch({ project: { columns: screen.settingsOf(next, known) } }),
					`${keys.length} keys`,
				).not.toThrow();
			}
		}
	});
});

describe('the columns in a patch', () => {
	test('are kept as they are sent', () => {
		const columns = {
			order: ['url', 'meta:title', 'virtual'],
			pinned: ['url'],
			widths: { url: 300, 'meta:title': 120 },
		};
		expect(parsePatch({ project: { columns } })).toEqual({ project: { columns } });
	});

	test('may leave out any of the three, and may be null (the default columns)', () => {
		expect(parsePatch({ project: { columns: { pinned: [] } } })).toEqual({
			project: { columns: { pinned: [] } },
		});
		expect(parsePatch({ project: { columns: null } })).toEqual({
			project: { columns: null },
		});
	});

	test('drop a field that is not known', () => {
		expect(parsePatch({ project: { columns: { pinned: [], kinds: { a: 1 } } } })).toEqual(
			{
				project: { columns: { pinned: [] } },
			},
		);
	});

	test('are refused when a list is not a list of columns, or names one twice', () => {
		expect(() => parsePatch({ project: { columns: 'url' } })).toThrow('"columns"');
		expect(() => parsePatch({ project: { columns: { order: 'url' } } })).toThrow(
			'"columns.order"',
		);
		expect(() => parsePatch({ project: { columns: { order: ['title'] } } })).toThrow(
			'"columns.order"',
		);
		expect(() =>
			parsePatch({ project: { columns: { pinned: ['url', 'url'] } } }),
		).toThrow('"columns.pinned"');
		expect(() => parsePatch({ project: { columns: { pinned: [1] } } })).toThrow(
			'"columns.pinned"',
		);
	});

	test('are refused when a list names more columns than the limit', () => {
		const many = Array.from({ length: MAX_COLUMNS + 1 }, (_, n) => `meta:k${n}`);
		expect(() => parsePatch({ project: { columns: { order: many } } })).toThrow(
			'"columns.order"',
		);
		const widths = Object.fromEntries(many.map((key) => [key, 100]));
		expect(() => parsePatch({ project: { columns: { widths } } })).toThrow(
			'"columns.widths"',
		);
	});

	test('are refused when a width is not a whole number of pixels in range', () => {
		for (const width of [
			MIN_COLUMN_WIDTH - 1,
			MAX_COLUMN_WIDTH + 1,
			100.5,
			'100',
			null,
			Number.NaN,
		]) {
			expect(
				() => parsePatch({ project: { columns: { widths: { url: width } } } }),
				String(width),
			).toThrow('"columns.widths"');
		}
		expect(() =>
			parsePatch({ project: { columns: { widths: { title: 100 } } } }),
		).toThrow('"columns.widths"');
		expect(
			parsePatch({
				project: {
					columns: { widths: { url: MIN_COLUMN_WIDTH, virtual: MAX_COLUMN_WIDTH } },
				},
			}),
		).toEqual({
			project: {
				columns: { widths: { url: MIN_COLUMN_WIDTH, virtual: MAX_COLUMN_WIDTH } },
			},
		});
	});

	test('keep a width of a column called __proto__ as a width', () => {
		const text = '{"project":{"columns":{"widths":{"meta:__proto__":100}}}}';
		const patch = parsePatch(JSON.parse(text));
		expect(Object.keys(patch.project?.columns?.widths ?? {})).toEqual(['meta:__proto__']);
	});
});

describe('the columns in the file', () => {
	const read = (columns: unknown) => {
		const parsed = parseSettings(
			JSON.stringify({ version: 1, projects: { a: { pageSize: 100, columns } } }),
		);
		expect(parsed.state).toBe('ok');
		return (parsed as Extract<typeof parsed, { state: 'ok' }>).settings.projects.a;
	};

	test('are cut to the most columns the server takes', () => {
		const many = Array.from({ length: MAX_COLUMNS + 20 }, (_, n) => `meta:k${n}`);
		const columns = read({
			order: many,
			pinned: many,
			widths: Object.fromEntries(many.map((key) => [key, 100])),
		})?.columns;
		expect(columns?.order).toHaveLength(MAX_COLUMNS);
		expect(columns?.pinned).toHaveLength(MAX_COLUMNS);
		expect(Object.keys(columns?.widths ?? {})).toHaveLength(MAX_COLUMNS);
	});

	test('are read, and what is not allowed is dropped', () => {
		expect(
			read({
				order: ['url', 'nope', 'meta:b', 'url', 3],
				pinned: ['meta:b', 'meta:b'],
				widths: { url: 200, virtual: 1, 'meta:b': 99_999, nope: 100, 'meta:c': 60.5 },
			})?.columns,
		).toEqual({ order: ['url', 'meta:b'], pinned: ['meta:b'], widths: { url: 200 } });
	});

	test('are left out when they are not an object, or hold nothing', () => {
		expect(read('url')).not.toHaveProperty('columns');
		expect(read({})).not.toHaveProperty('columns');
		expect(read({ order: 'url' })).not.toHaveProperty('columns');
	});

	test('keep an empty pinned list, which is the person unpinning every column', () => {
		expect(read({ pinned: [] })?.columns).toEqual({ pinned: [] });
	});
});

describe('saving the columns', () => {
	test('is saved with the rest of the project, and null removes them', async () => {
		const store = createSettingsStore(file, KEY);
		await store.update({ project: { pageSize: 100 } });
		const columns = { order: ['url', 'meta:b'], pinned: ['url'], widths: { url: 300 } };
		const view = await store.update({ project: { columns } });
		expect(view.project).toMatchObject({ pageSize: 100, columns });
		const written = JSON.parse(await readFile(file, 'utf8')) as {
			projects: Record<string, { columns?: unknown }>;
		};
		expect(written.projects[KEY]?.columns).toEqual(columns);
		const cleared = await store.update({ project: { columns: null } });
		expect(cleared.project).not.toHaveProperty('columns');
		expect(cleared.project?.pageSize).toBe(100);
	});

	test('an empty object is the same as null: the default layout comes back', async () => {
		const store = createSettingsStore(file, KEY);
		await store.update({ project: { columns: { pinned: ['meta:b'] } } });
		const view = await store.update({ project: { columns: {} } });
		expect(view.project).not.toHaveProperty('columns');
	});

	test('a save of the sort or of the page size leaves them as they were', async () => {
		const store = createSettingsStore(file, KEY);
		const columns = { pinned: ['meta:b'] };
		await store.update({ project: { columns } });
		const view = await store.update({
			project: { pageSize: 1000, sort: { key: 'url', desc: false } },
		});
		expect(view.project?.columns).toEqual(columns);
	});

	test('a save of the columns replaces all three lists, as the screen sends them whole', async () => {
		const store = createSettingsStore(file, KEY);
		await store.update({
			project: { columns: { order: ['url'], pinned: ['url'], widths: { url: 300 } } },
		});
		const view = await store.update({ project: { columns: { pinned: [] } } });
		expect(view.project?.columns).toEqual({ pinned: [] });
	});
});
