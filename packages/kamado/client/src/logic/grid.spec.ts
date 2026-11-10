import { describe, expect, test } from 'vitest';

import { clampPage, nextCell, pageCount, rangeLabel } from './grid.js';

const SIZE = { rows: 10, cols: 4, screen: 4 };

describe('nextCell', () => {
	test('the arrows move one cell', () => {
		const at = { row: 3, col: 2 };
		expect(nextCell(at, 'ArrowUp', false, SIZE)).toEqual({ row: 2, col: 2 });
		expect(nextCell(at, 'ArrowDown', false, SIZE)).toEqual({ row: 4, col: 2 });
		expect(nextCell(at, 'ArrowLeft', false, SIZE)).toEqual({ row: 3, col: 1 });
		expect(nextCell(at, 'ArrowRight', false, SIZE)).toEqual({ row: 3, col: 3 });
	});
	test('the edges hold', () => {
		expect(nextCell({ row: 0, col: 0 }, 'ArrowUp', false, SIZE)).toEqual({
			row: 0,
			col: 0,
		});
		expect(nextCell({ row: 0, col: 0 }, 'ArrowLeft', false, SIZE)).toEqual({
			row: 0,
			col: 0,
		});
		expect(nextCell({ row: 9, col: 3 }, 'ArrowDown', false, SIZE)).toEqual({
			row: 9,
			col: 3,
		});
		expect(nextCell({ row: 9, col: 3 }, 'ArrowRight', false, SIZE)).toEqual({
			row: 9,
			col: 3,
		});
	});
	test('Home and End go to the ends of the row, with Ctrl of the grid', () => {
		const at = { row: 5, col: 2 };
		expect(nextCell(at, 'Home', false, SIZE)).toEqual({ row: 5, col: 0 });
		expect(nextCell(at, 'End', false, SIZE)).toEqual({ row: 5, col: 3 });
		expect(nextCell(at, 'Home', true, SIZE)).toEqual({ row: 0, col: 0 });
		expect(nextCell(at, 'End', true, SIZE)).toEqual({ row: 9, col: 3 });
	});
	test('Page Up and Page Down move a screenful and stop at the ends', () => {
		expect(nextCell({ row: 5, col: 1 }, 'PageDown', false, SIZE)).toEqual({
			row: 9,
			col: 1,
		});
		expect(nextCell({ row: 5, col: 1 }, 'PageUp', false, SIZE)).toEqual({
			row: 1,
			col: 1,
		});
		expect(nextCell({ row: 1, col: 1 }, 'PageUp', false, SIZE)).toEqual({
			row: 0,
			col: 1,
		});
	});
	test('another key, or a grid with nothing in it, leaves the focus', () => {
		const at = { row: 2, col: 2 };
		expect(nextCell(at, 'a', false, SIZE)).toBe(at);
		expect(nextCell(at, 'ArrowDown', false, { rows: 0, cols: 4, screen: 4 })).toBe(at);
		expect(nextCell(at, 'ArrowRight', false, { rows: 4, cols: 0, screen: 4 })).toBe(at);
	});
	test('Ctrl does not change Page Up and Page Down', () => {
		expect(nextCell({ row: 5, col: 1 }, 'PageDown', true, SIZE)).toEqual({
			row: 9,
			col: 1,
		});
		expect(nextCell({ row: 5, col: 1 }, 'PageUp', true, SIZE)).toEqual({
			row: 1,
			col: 1,
		});
	});
});

describe('paging', () => {
	test('there is always one page', () => {
		expect(pageCount(0, 500)).toBe(1);
		expect(pageCount(500, 500)).toBe(1);
		expect(pageCount(501, 500)).toBe(2);
	});
	test('a page past the end is held to the last, and before the start to the first', () => {
		expect(clampPage(9, 1001, 500)).toBe(2);
		expect(clampPage(-1, 1001, 500)).toBe(0);
		expect(clampPage(1, 0, 500)).toBe(0);
	});
	test('the range label counts from 1 and groups digits', () => {
		expect(rangeLabel(0, 0, 0)).toBe('0 / 0');
		expect(rangeLabel(500, 500, 1234)).toBe('501–1,000 / 1,234');
	});
});
