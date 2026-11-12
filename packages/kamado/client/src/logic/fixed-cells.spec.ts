import { describe, expect, test } from 'vitest';

import { fixedCellOf, isFixedBox } from './fixed-cells.js';
import { columnIds } from './layout.js';

const PAGE = {
	url: '/about/team.html',
	inputPath: 'about/team.html',
	outputPath: 'about/team.html',
	virtual: false,
	order: 12,
	depth: 2,
	parent: '/about/',
};

const VIRTUAL = {
	url: '/',
	inputPath: null,
	outputPath: 'index.html',
	virtual: true,
	order: 1,
	depth: 0,
	parent: null,
};

describe('the cells of the columns every row has', () => {
	test('url and inputPath are edited as text', () => {
		expect(fixedCellOf(PAGE, 'url')).toEqual({
			text: '/about/team.html',
			readOnly: false,
		});
		expect(fixedCellOf(PAGE, 'inputPath')).toEqual({
			text: 'about/team.html',
			readOnly: false,
		});
	});

	test('the inputPath of a virtual page is empty and edited: a path gives the page a file', () => {
		expect(fixedCellOf(VIRTUAL, 'inputPath')).toEqual({ text: '', readOnly: false });
	});

	test('virtual is a box that can be turned over, checked for a virtual page', () => {
		expect(fixedCellOf(PAGE, 'virtual')).toEqual({
			text: '',
			readOnly: false,
			checked: false,
		});
		expect(fixedCellOf(VIRTUAL, 'virtual')).toEqual({
			text: '',
			readOnly: false,
			checked: true,
		});
		expect(isFixedBox('virtual')).toBe(true);
	});

	test('what the plan makes of the page is shown and read only', () => {
		// Behavior change: the number of the place in the plan is no column any more (RFC section 14.2): `order` is a key of the metadata
		expect(fixedCellOf(PAGE, 'order')).toBeNull();
		// expect(fixedCellOf(PAGE, 'order')).toEqual({ text: '12', readOnly: true }); // previous
		expect(fixedCellOf(PAGE, 'outputPath')).toEqual({
			text: 'about/team.html',
			readOnly: true,
		});
		expect(fixedCellOf(PAGE, 'parent')).toEqual({ text: '/about/', readOnly: true });
		expect(fixedCellOf(PAGE, 'depth')).toEqual({ text: '2', readOnly: true });
	});

	test('a page without a page above it, and a depth of 0, are shown as they are', () => {
		expect(fixedCellOf(VIRTUAL, 'parent')).toEqual({ text: '', readOnly: true });
		expect(fixedCellOf(VIRTUAL, 'depth')).toEqual({ text: '0', readOnly: true });
	});

	test('every fixed column has a cell, and a key of the metadata has none here', () => {
		for (const id of columnIds([])) {
			expect(fixedCellOf(PAGE, id), id).not.toBeNull();
		}
		expect(fixedCellOf(PAGE, 'meta:title')).toBeNull();
		// a key with the name of a fixed column is a key
		expect(fixedCellOf(PAGE, 'meta:order')).toBeNull();
	});

	test('only virtual is a box', () => {
		for (const id of columnIds(['title']).filter((column) => column !== 'virtual')) {
			expect(isFixedBox(id), id).toBe(false);
		}
	});
});
