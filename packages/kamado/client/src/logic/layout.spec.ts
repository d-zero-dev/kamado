import { describe, expect, test } from 'vitest';

import {
	MAX_COLUMNS,
	MAX_COLUMNS_BYTES,
	MAX_COLUMN_WIDTH,
	MIN_COLUMN_WIDTH,
	columnIds,
	columnName,
	defaultWidth,
	emptyLayout,
	layoutOf,
	moveColumn,
	moveColumnTo,
	opensMenu,
	pinColumn,
	positionOf,
	resetWidth,
	resizeColumn,
	settingsOf,
	stateOf,
	unpinColumn,
	widthOf,
	type ColumnState,
} from './layout.js';

const KNOWN = columnIds(['b', 'a', 'c']);

/**
 * The ids the columns are shown in.
 * @param state
 * @param known
 */
const shown = (state: ColumnState, known: readonly string[] = KNOWN) =>
	layoutOf(known, state).shown;

describe('columnIds', () => {
	test('puts the three fixed columns first and the keys after them, in the order of their names', () => {
		expect(KNOWN).toEqual(['url', 'virtual', 'inputPath', 'meta:a', 'meta:b', 'meta:c']);
	});

	test('names a key `url` as a key, not as the URL', () => {
		expect(columnIds(['url'])).toEqual(['url', 'virtual', 'inputPath', 'meta:url']);
	});
});

describe('columnName', () => {
	test('is the text of the header: a fixed column by its name, a key by the key', () => {
		expect(columnName('url')).toBe('url');
		expect(columnName('meta:title')).toBe('title');
		expect(columnName('meta:url')).toBe('url');
	});
});

describe('layoutOf', () => {
	test('is the default with nothing set: the URL pinned, then the columns in their order', () => {
		const layout = layoutOf(KNOWN, emptyLayout());
		expect(layout.shown).toEqual(KNOWN);
		expect(layout.pinnedCount).toBe(1);
		expect(layout.widths).toEqual([448, 96, 384, 224, 224, 224]);
		expect(layout.lefts).toEqual([0]);
	});

	test('puts the pinned columns first in the order they were pinned, then the rest in order', () => {
		const state: ColumnState = {
			order: ['meta:c', 'url', 'meta:a'],
			pinned: ['meta:b', 'url'],
			widths: {},
		};
		const layout = layoutOf(KNOWN, state);
		expect(layout.shown).toEqual([
			'meta:b',
			'url',
			// The rest: the saved order first, the columns the order does not name after them.
			'meta:c',
			'meta:a',
			'virtual',
			'inputPath',
		]);
		expect(layout.pinnedCount).toBe(2);
	});

	test('measures where each pinned column sticks: after the widths of the pinned columns before it', () => {
		const state: ColumnState = {
			order: undefined,
			pinned: ['meta:a', 'url', 'virtual'],
			widths: { 'meta:a': 100, url: 300 },
		};
		const layout = layoutOf(KNOWN, state);
		expect(layout.lefts).toEqual([0, 100, 400]);
		expect(layout.widths.slice(0, 3)).toEqual([100, 300, defaultWidth('virtual')]);
	});

	test('leaves out a column that is not there any more, and puts a new one last', () => {
		const state: ColumnState = {
			order: ['meta:gone', 'meta:c', 'url'],
			pinned: ['meta:gone'],
			widths: { 'meta:gone': 80 },
		};
		const layout = layoutOf(KNOWN, state);
		expect(layout.shown).not.toContain('meta:gone');
		expect(layout.pinnedCount).toBe(0);
		// The order, then the columns it does not name in their own order (a new key goes last).
		expect(layout.shown).toEqual([
			'meta:c',
			'url',
			'virtual',
			'inputPath',
			'meta:a',
			'meta:b',
		]);
	});

	test('names a column once even when the lists name it twice', () => {
		const layout = layoutOf(KNOWN, {
			order: ['url', 'url', 'meta:a'],
			pinned: ['meta:a', 'meta:a'],
			widths: {},
		});
		expect(new Set(layout.shown).size).toBe(layout.shown.length);
		expect(layout.shown).toHaveLength(KNOWN.length);
	});

	test('can have no pinned column', () => {
		const layout = layoutOf(KNOWN, { order: undefined, pinned: [], widths: {} });
		expect(layout.pinnedCount).toBe(0);
		expect(layout.lefts).toEqual([]);
		expect(layout.shown).toEqual(KNOWN);
	});

	test('holds a width to the range the server takes', () => {
		const layout = layoutOf(KNOWN, {
			order: undefined,
			pinned: [],
			widths: { url: 1, virtual: 99_999 },
		});
		expect(layout.widths[0]).toBe(MIN_COLUMN_WIDTH);
		expect(layout.widths[1]).toBe(MAX_COLUMN_WIDTH);
	});
});

describe('positionOf', () => {
	test('is the place of a column among those shown, or -1', () => {
		const layout = layoutOf(KNOWN, emptyLayout());
		expect(positionOf(layout, 'inputPath')).toBe(2);
		expect(positionOf(layout, 'meta:nope')).toBe(-1);
	});
});

describe('widthOf', () => {
	test('is the width a column is drawn with, and 0 for a column that is not shown', () => {
		const layout = layoutOf(KNOWN, resizeColumn(emptyLayout(), 'meta:a', 150));
		expect(widthOf(layout, 'meta:a')).toBe(150);
		expect(widthOf(layout, 'url')).toBe(defaultWidth('url'));
		expect(widthOf(layout, 'meta:nope')).toBe(0);
	});
});

describe('opensMenu', () => {
	test('is true for Alt+ArrowDown, the menu key and Shift+F10', () => {
		expect(opensMenu('ArrowDown', true, false)).toBe(true);
		expect(opensMenu('ContextMenu', false, false)).toBe(true);
		expect(opensMenu('F10', false, true)).toBe(true);
	});

	test('is false for the keys that move in the grid', () => {
		expect(opensMenu('ArrowDown', false, false)).toBe(false);
		expect(opensMenu('F10', false, false)).toBe(false);
		expect(opensMenu('ArrowUp', true, false)).toBe(false);
		expect(opensMenu('Enter', true, false)).toBe(false);
	});
});

describe('pinColumn and unpinColumn', () => {
	test('pin a column after the pinned ones and unpin it back to its place in the order', () => {
		const pinned = pinColumn(emptyLayout(), KNOWN, 'meta:b');
		expect(shown(pinned)).toEqual([
			'url',
			'meta:b',
			'virtual',
			'inputPath',
			'meta:a',
			'meta:c',
		]);
		const back = unpinColumn(pinned, KNOWN, 'meta:b');
		expect(shown(back)).toEqual(KNOWN);
	});

	test('let the default pinned column go when it is unpinned', () => {
		const state = unpinColumn(emptyLayout(), KNOWN, 'url');
		expect(state.pinned).toEqual([]);
		expect(layoutOf(KNOWN, state).pinnedCount).toBe(0);
	});

	test('pinning a pinned column and unpinning one that is not change nothing', () => {
		const state = pinColumn(emptyLayout(), KNOWN, 'meta:a');
		expect(pinColumn(state, KNOWN, 'meta:a')).toEqual(state);
		expect(unpinColumn(state, KNOWN, 'meta:c')).toEqual(state);
	});

	test('do not change the state they were given', () => {
		const state = emptyLayout();
		const before = JSON.stringify(state);
		pinColumn(state, KNOWN, 'meta:a');
		unpinColumn(state, KNOWN, 'url');
		expect(JSON.stringify(state)).toBe(before);
	});
});

describe('moveColumn', () => {
	test('moves a column one place left or right among the columns that are not pinned', () => {
		const right = moveColumn(emptyLayout(), KNOWN, 'virtual', 1);
		expect(shown(right)).toEqual([
			'url',
			'inputPath',
			'virtual',
			'meta:a',
			'meta:b',
			'meta:c',
		]);
		const left = moveColumn(right, KNOWN, 'virtual', -1);
		expect(shown(left)).toEqual(KNOWN);
	});

	test('moves a pinned column among the pinned ones only', () => {
		const state = pinColumn(pinColumn(emptyLayout(), KNOWN, 'meta:a'), KNOWN, 'meta:b');
		expect(shown(state).slice(0, 3)).toEqual(['url', 'meta:a', 'meta:b']);
		const moved = moveColumn(state, KNOWN, 'meta:b', -1);
		expect(shown(moved).slice(0, 3)).toEqual(['url', 'meta:b', 'meta:a']);
		// The first pinned column cannot go left of the first place, and cannot cross into the rest.
		expect(moveColumn(state, KNOWN, 'url', -1)).toEqual(state);
		expect(moveColumn(state, KNOWN, 'meta:b', 1)).toEqual(state);
	});

	test('does nothing at the end of the row, and for a column that is not there', () => {
		const state = emptyLayout();
		expect(moveColumn(state, KNOWN, 'meta:c', 1)).toEqual(state);
		expect(moveColumn(state, KNOWN, 'virtual', -1)).toEqual(state);
		expect(moveColumn(state, KNOWN, 'meta:nope', 1)).toEqual(state);
	});

	test('keeps the places of the pinned columns in the order, so that unpinning puts them back', () => {
		const state = pinColumn(emptyLayout(), KNOWN, 'meta:a');
		const moved = moveColumn(state, KNOWN, 'virtual', 1);
		expect(shown(unpinColumn(moved, KNOWN, 'meta:a'))).toEqual([
			'url',
			'inputPath',
			'virtual',
			'meta:a',
			'meta:b',
			'meta:c',
		]);
	});
});

describe('pinColumn of a column that is not there', () => {
	test('changes nothing', () => {
		const state = emptyLayout();
		expect(pinColumn(state, KNOWN, 'meta:nope')).toEqual(state);
	});
});

describe('moveColumnTo among the pinned columns', () => {
	test('reorders the pinned columns in the order they are shown', () => {
		const state = pinColumn(pinColumn(emptyLayout(), KNOWN, 'meta:a'), KNOWN, 'meta:b');
		const moved = moveColumnTo(state, KNOWN, 'meta:b', 'url');
		expect(shown(moved).slice(0, 3)).toEqual(['meta:b', 'url', 'meta:a']);
	});
});

describe('moveColumnTo', () => {
	test('puts a column in the place of another that is in the same group', () => {
		const moved = moveColumnTo(emptyLayout(), KNOWN, 'meta:c', 'virtual');
		expect(shown(moved)).toEqual([
			'url',
			'meta:c',
			'virtual',
			'inputPath',
			'meta:a',
			'meta:b',
		]);
		const other = moveColumnTo(emptyLayout(), KNOWN, 'virtual', 'meta:b');
		expect(shown(other)).toEqual([
			'url',
			'inputPath',
			'meta:a',
			'meta:b',
			'virtual',
			'meta:c',
		]);
	});

	test('does nothing when the two are in different groups, or the same, or not there', () => {
		const state = emptyLayout();
		expect(moveColumnTo(state, KNOWN, 'meta:a', 'url')).toEqual(state);
		expect(moveColumnTo(state, KNOWN, 'virtual', 'virtual')).toEqual(state);
		expect(moveColumnTo(state, KNOWN, 'virtual', 'meta:nope')).toEqual(state);
	});
});

describe('resizeColumn and resetWidth', () => {
	test('set the width, held to the range, as a whole number', () => {
		expect(resizeColumn(emptyLayout(), 'meta:a', 150.6).widths['meta:a']).toBe(151);
		expect(resizeColumn(emptyLayout(), 'meta:a', 1).widths['meta:a']).toBe(
			MIN_COLUMN_WIDTH,
		);
		expect(resizeColumn(emptyLayout(), 'meta:a', 1e9).widths['meta:a']).toBe(
			MAX_COLUMN_WIDTH,
		);
	});

	test('keep no width for a column that is made the width it has by default', () => {
		const wide = resizeColumn(emptyLayout(), 'meta:a', 300);
		const back = resizeColumn(wide, 'meta:a', defaultWidth('meta:a'));
		expect(back.widths).toEqual({});
		expect(resetWidth(wide, 'meta:a').widths).toEqual({});
	});

	test('ignore a width that is not a finite number', () => {
		const state = emptyLayout();
		expect(resizeColumn(state, 'meta:a', Number.NaN)).toEqual(state);
		expect(resizeColumn(state, 'meta:a', Number.POSITIVE_INFINITY)).toEqual(state);
	});

	test('are drawn as whole pixels in range, whatever the state holds', () => {
		const layout = layoutOf(KNOWN, {
			order: undefined,
			pinned: [],
			widths: { url: 100.4, virtual: 100.6, 'meta:a': -5 },
		});
		expect(layout.widths.slice(0, 2)).toEqual([100, 101]);
		expect(widthOf(layout, 'meta:a')).toBe(MIN_COLUMN_WIDTH);
	});

	test('keep the widths of the other columns', () => {
		const state = resizeColumn(resizeColumn(emptyLayout(), 'url', 200), 'meta:a', 300);
		expect(resetWidth(state, 'url').widths).toEqual({ 'meta:a': 300 });
	});
});

describe('stateOf and settingsOf', () => {
	test('read what the server holds, and the default layout when it holds none', () => {
		expect(stateOf()).toEqual(emptyLayout());
		expect(stateOf({ order: ['url'], widths: { url: 100 } })).toEqual({
			order: ['url'],
			pinned: undefined,
			widths: { url: 100 },
		});
	});

	test('make the whole of the three lists as they are shown', () => {
		const state = pinColumn(
			resizeColumn(moveColumn(emptyLayout(), KNOWN, 'virtual', 1), 'meta:a', 100),
			KNOWN,
			'meta:b',
		);
		expect(settingsOf(state, KNOWN)).toEqual({
			order: ['url', 'inputPath', 'virtual', 'meta:a', 'meta:b', 'meta:c'],
			pinned: ['url', 'meta:b'],
			widths: { 'meta:a': 100 },
		});
	});

	test('keep what the state holds of a column that is not there, after the columns that are', () => {
		const state: ColumnState = {
			order: ['meta:gone', 'meta:c', 'url'],
			pinned: ['meta:gone', 'url'],
			widths: { 'meta:gone': 80, url: 300 },
		};
		const saved = settingsOf(state, KNOWN);
		expect(saved.order).toEqual([
			'meta:c',
			'url',
			'virtual',
			'inputPath',
			'meta:a',
			'meta:b',
			'meta:gone',
		]);
		expect(saved.pinned).toEqual(['url', 'meta:gone']);
		expect(saved.widths).toEqual({ 'meta:gone': 80, url: 300 });
		// And the column that is gone is still not shown.
		expect(layoutOf(KNOWN, stateOf(saved)).shown).not.toContain('meta:gone');
	});

	test('leave out a column the server would refuse, so that the rest is not refused with it', () => {
		const known = columnIds(['', 'k'.repeat(300), 'title']);
		const saved = settingsOf({ order: [], pinned: undefined, widths: {} }, known);
		expect(saved.order).toEqual(['url', 'virtual', 'inputPath', 'meta:title']);
		const withWidth = settingsOf(resizeColumn(emptyLayout(), 'meta:', 100), known);
		expect(withWidth.widths).toEqual({});
	});

	test('do not fix the order of the columns when the person has only pinned or resized', () => {
		const state = resizeColumn(pinColumn(emptyLayout(), KNOWN, 'meta:a'), 'url', 300);
		const saved = settingsOf(state, KNOWN);
		expect(saved).not.toHaveProperty('order');
		expect(saved.pinned).toEqual(['url', 'meta:a']);
	});

	test('are cut to fit the bytes a change of the settings may take, whatever the keys are', () => {
		const long = Array.from({ length: MAX_COLUMNS }, (_, n) => `${'k'.repeat(240)}${n}`);
		const known = columnIds(long);
		const state: ColumnState = {
			order: [],
			pinned: known,
			widths: Object.fromEntries(known.map((id) => [id, 100])),
		};
		const saved = settingsOf(state, known);
		expect(new TextEncoder().encode(JSON.stringify(saved)).length).toBeLessThanOrEqual(
			MAX_COLUMNS_BYTES,
		);
		// And a layout of ordinary keys is not cut.
		const ordinary = columnIds(['a', 'b', 'c']);
		expect(
			settingsOf({ order: [], pinned: ordinary, widths: {} }, ordinary).order,
		).toHaveLength(ordinary.length);
	});

	test('are held to the most columns the server takes', () => {
		const many = columnIds(Array.from({ length: MAX_COLUMNS + 10 }, (_, n) => `k${n}`));
		expect(
			settingsOf({ order: [], pinned: undefined, widths: {} }, many).order,
		).toHaveLength(MAX_COLUMNS);
	});

	test('keep a column that is not there through every change, so that it is found again', () => {
		const state: ColumnState = {
			order: ['meta:gone', 'url', 'meta:c'],
			pinned: ['url', 'meta:gone'],
			widths: {},
		};
		const changed = [
			pinColumn(state, KNOWN, 'meta:b'),
			unpinColumn(state, KNOWN, 'url'),
			moveColumn(state, KNOWN, 'meta:a', 1),
			moveColumnTo(state, KNOWN, 'meta:c', 'virtual'),
		];
		for (const next of changed) {
			const saved = settingsOf(next, KNOWN);
			expect(saved.order, 'order').toContain('meta:gone');
			expect(saved.pinned, 'pinned').toContain('meta:gone');
		}
		// And it comes back pinned, after the pinned columns that were there, when the key does.
		const back = columnIds(['a', 'b', 'c', 'gone']);
		const layout = layoutOf(
			back,
			stateOf(settingsOf(pinColumn(state, KNOWN, 'meta:b'), KNOWN)),
		);
		expect(layout.shown.slice(0, 3)).toEqual(['url', 'meta:b', 'meta:gone']);
	});

	test('are the same layout when they go to the server and come back', () => {
		const state = pinColumn(
			moveColumn(emptyLayout(), KNOWN, 'meta:c', -1),
			KNOWN,
			'meta:c',
		);
		const back = stateOf(settingsOf(state, KNOWN));
		expect(layoutOf(KNOWN, back)).toEqual(layoutOf(KNOWN, state));
	});
});
