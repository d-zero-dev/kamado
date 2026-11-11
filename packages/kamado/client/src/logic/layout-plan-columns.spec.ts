import { describe, expect, test } from 'vitest';

import { english, translator } from '../i18n/translate.js';

import {
	clashesWithFixedColumn,
	columnIds,
	columnLabel,
	defaultWidth,
	emptyLayout,
	layoutOf,
	pinColumn,
	settingsOf,
	stateOf,
} from './layout.js';
import { canSort } from './sort.js';

/** The columns that say what the plan makes of a page. */
const PLAN_COLUMNS = ['order', 'outputPath', 'parent', 'depth'];

describe('the columns of what the plan makes of a page', () => {
	test('are fixed columns, after the three of the page itself and before the keys', () => {
		expect(columnIds([]).slice(0, 3)).toEqual(['url', 'virtual', 'inputPath']);
		expect(columnIds([]).slice(3)).toEqual(PLAN_COLUMNS);
		expect(columnIds(['title']).at(-1)).toBe('meta:title');
	});

	test.each([
		['order', 96],
		['outputPath', 384],
		['parent', 320],
		['depth', 96],
	])('%s is %d pixels wide until it is changed', (id, width) => {
		expect(defaultWidth(id)).toBe(width);
	});

	test.each(PLAN_COLUMNS)('%s can be sorted by', (id) => {
		expect(canSort(id)).toBe(true);
	});

	test('are not pinned until the person pins them', () => {
		const known = columnIds(['title']);
		expect(layoutOf(known, emptyLayout()).pinnedCount).toBe(1);
		const pinned = pinColumn(emptyLayout(), known, 'order');
		expect(layoutOf(known, pinned).shown.slice(0, 2)).toEqual(['url', 'order']);
	});

	test('are put after the columns of a saved layout that does not name them', () => {
		// A saved order that names only url, virtual, inputPath and a key.
		const saved = stateOf({ order: ['url', 'meta:title', 'virtual', 'inputPath'] });
		const known = columnIds(['title']);
		expect(layoutOf(known, saved).shown).toEqual([
			'url',
			'meta:title',
			'virtual',
			'inputPath',
			...PLAN_COLUMNS,
		]);
		// And the layout that is saved next names them where they are shown.
		expect(settingsOf(pinColumn(saved, known, 'depth'), known)).toMatchObject({
			pinned: ['url', 'depth'],
		});
	});
});

describe('a key of the metadata that has the name of one of them', () => {
	test.each(PLAN_COLUMNS)(
		'meta:%s is told from the fixed column by its label',
		(name) => {
			const id = `meta:${name}`;
			expect(clashesWithFixedColumn(id)).toBe(true);
			expect(clashesWithFixedColumn(name)).toBe(false);
			expect(columnLabel(id, english)).toBe(`${name} (meta)`);
			expect(columnLabel(id, translator('ja'))).toBe(`${name}（メタ）`);
			expect(columnLabel(name, english)).toBe(name);
		},
	);

	test('is a column of its own beside the fixed one', () => {
		const known = columnIds(['order']);
		expect(known).toContain('order');
		expect(known).toContain('meta:order');
		expect(new Set(known).size).toBe(known.length);
	});
});
