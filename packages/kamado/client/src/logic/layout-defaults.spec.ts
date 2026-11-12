import { describe, expect, test } from 'vitest';

import {
	MAX_COLUMNS_BYTES,
	columnIds,
	emptyLayout,
	layoutOf,
	moveColumn,
	pinColumn,
	resizeColumn,
	settingsOf,
	stateOf,
	unpinColumn,
	type ColumnState,
} from './layout.js';

const KNOWN = columnIds(['layout', 'title', 'nav']);

/**
 * The identifiers the columns are shown in.
 * @param state - The state
 * @param known - The columns there are
 */
const shown = (state: ColumnState, known: readonly string[] = KNOWN) =>
	layoutOf(known, state).shown;

describe('the defaults of the config', () => {
	test('without defaults the layout is the fixed columns, then the keys by name, with the URL pinned', () => {
		expect(stateOf()).toEqual(emptyLayout());
		expect(stateOf({}, {})).toEqual(emptyLayout());
		expect(layoutOf(KNOWN, stateOf(undefined, {})).pinnedCount).toBe(1);
		expect(shown(stateOf(undefined, {}))).toEqual([
			'url',
			'virtual',
			'inputPath',
			'order',
			'outputPath',
			'parent',
			'depth',
			'meta:layout',
			'meta:nav',
			'meta:title',
		]);
	});

	test('the default order puts the columns it names first and the others after them, in the default order', () => {
		const state = stateOf(undefined, {
			order: ['meta:title', 'meta:layout', 'inputPath'],
		});
		expect(shown(state)).toEqual([
			'url',
			'meta:title',
			'meta:layout',
			'inputPath',
			'virtual',
			'order',
			'outputPath',
			'parent',
			'depth',
			'meta:nav',
		]);
	});

	test('the default pinned columns stick in the order written, whatever the default order says', () => {
		const state = stateOf(undefined, {
			order: ['url', 'meta:title', 'meta:layout'],
			pinned: ['meta:layout', 'url'],
		});
		const layout = layoutOf(KNOWN, state);
		expect(layout.pinnedCount).toBe(2);
		expect(layout.shown.slice(0, 3)).toEqual(['meta:layout', 'url', 'meta:title']);
	});

	test('an empty default pins none, and without one only the URL is pinned', () => {
		expect(layoutOf(KNOWN, stateOf(undefined, { pinned: [] })).pinnedCount).toBe(0);
		expect(
			layoutOf(KNOWN, stateOf(undefined, { order: ['meta:title'] })).pinnedCount,
		).toBe(1);
	});

	test('an empty default order is no order', () => {
		expect(shown(stateOf(undefined, { order: [] }))).toEqual([
			'url',
			'virtual',
			'inputPath',
			'order',
			'outputPath',
			'parent',
			'depth',
			'meta:layout',
			'meta:nav',
			'meta:title',
		]);
	});

	test('what the person saved wins, field by field', () => {
		const defaults = { order: ['meta:title', 'url'], pinned: ['meta:title'] };
		// Both saved: the defaults are not read at all.
		const both = stateOf({ order: ['inputPath', 'url'], pinned: [] }, defaults);
		expect(shown(both).slice(0, 2)).toEqual(['inputPath', 'url']);
		expect(layoutOf(KNOWN, both).pinnedCount).toBe(0);
		// Only the pinned columns saved: the order is still the default one.
		const pinnedOnly = stateOf({ pinned: ['url'] }, defaults);
		expect(layoutOf(KNOWN, pinnedOnly).pinnedCount).toBe(1);
		expect(shown(pinnedOnly).slice(0, 3)).toEqual(['url', 'meta:title', 'virtual']);
		// Only the order saved: the pinned columns are still the default ones.
		const orderOnly = stateOf({ order: ['inputPath'] }, defaults);
		expect(shown(orderOnly).slice(0, 2)).toEqual(['meta:title', 'inputPath']);
		expect(layoutOf(KNOWN, orderOnly).pinnedCount).toBe(1);
	});

	test('a column that the defaults name and no page has is not shown', () => {
		const state = stateOf(undefined, {
			order: ['meta:gone', 'meta:title'],
			pinned: ['url', 'meta:gone'],
		});
		expect(shown(state)).not.toContain('meta:gone');
		expect(layoutOf(KNOWN, state).pinnedCount).toBe(1);
	});

	test('it is found again when a page has the key', () => {
		const state = stateOf(undefined, { pinned: ['url', 'meta:title'] });
		expect(layoutOf(columnIds(['layout']), state).pinnedCount).toBe(1);
		expect(layoutOf(columnIds(['layout', 'title']), state).pinnedCount).toBe(2);
	});
});

describe('saving over the defaults', () => {
	const defaults = {
		order: ['meta:title', 'meta:gone'],
		pinned: ['url', 'meta:title', 'meta:gone'],
	};

	test('a change of a width saves the pinned columns of the defaults, those no page has too', () => {
		const state = resizeColumn(stateOf(undefined, defaults), 'meta:title', 300);
		const saved = settingsOf(state, KNOWN);
		expect(saved.pinned).toEqual(['url', 'meta:title', 'meta:gone']);
		// The order is saved once the person has set one, and not by a width.
		expect(saved.order).toBeUndefined();
		expect(saved.widths).toEqual({ 'meta:title': 300 });
	});

	test('pinning a column keeps the default pinned columns no page has', () => {
		const state = pinColumn(stateOf(undefined, defaults), KNOWN, 'meta:nav');
		expect(state.pinned).toEqual(['url', 'meta:title', 'meta:nav', 'meta:gone']);
		expect(settingsOf(state, KNOWN).pinned).toEqual([
			'url',
			'meta:title',
			'meta:nav',
			'meta:gone',
		]);
	});

	test('unpinning a column keeps the default pinned columns no page has', () => {
		const state = unpinColumn(stateOf(undefined, defaults), KNOWN, 'url');
		expect(state.pinned).toEqual(['meta:title', 'meta:gone']);
	});

	test('moving a column saves the order, from the default order, with the columns no page has after those there are', () => {
		const state = moveColumn(stateOf(undefined, defaults), KNOWN, 'inputPath', -1);
		const saved = settingsOf(state, KNOWN);
		// The default order first (the title, which is pinned and keeps its place), then the columns
		// of the plan with the one that was moved ahead of its neighbour, then the column no page has.
		expect(saved.order).toEqual([
			'meta:title',
			'url',
			'inputPath',
			'virtual',
			'order',
			'outputPath',
			'parent',
			'depth',
			'meta:layout',
			'meta:nav',
			'meta:gone',
		]);
		// What is saved shows the same when it is read again.
		expect(shown(stateOf(saved, defaults))).toEqual(shown(state));
	});

	test('moving a pinned column keeps the default pinned columns no page has', () => {
		const state = moveColumn(stateOf(undefined, defaults), KNOWN, 'meta:title', -1);
		expect(state.pinned).toEqual(['meta:title', 'url', 'meta:gone']);
		expect(settingsOf(state, KNOWN).pinned).toEqual(['meta:title', 'url', 'meta:gone']);
	});

	test('defaults too long to be saved whole are cut at the end, as any layout is, and what is kept is the start of them', () => {
		// 400 keys of 250 characters: 100 KB, where a layout is saved in 48 KiB at most.
		const long = Array.from(
			{ length: 400 },
			(_, i) => `meta:${i}-${'x'.repeat(244 - String(i).length)}`,
		);
		const pinned = ['url', ...long];
		const state = resizeColumn(stateOf(undefined, { pinned }), 'meta:title', 300);
		const saved = settingsOf(state, KNOWN);
		const bytes = new TextEncoder().encode(JSON.stringify(saved)).length;
		expect(bytes).toBeLessThanOrEqual(MAX_COLUMNS_BYTES);
		expect(saved.pinned?.[0]).toBe('url');
		expect(saved.pinned?.length).toBeLessThan(pinned.length);
		expect(saved.pinned).toEqual(pinned.slice(0, saved.pinned?.length));
	});

	test('without defaults a change of a width saves the URL as pinned, and the width', () => {
		const state = resizeColumn(emptyLayout(), 'meta:title', 300);
		expect(settingsOf(state, KNOWN)).toEqual({
			pinned: ['url'],
			widths: { 'meta:title': 300 },
		});
	});
});
