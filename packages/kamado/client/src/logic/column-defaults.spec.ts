import { describe, expect, test } from 'vitest';

import {
	parseColumnDefaults,
	resetOf,
	resetPatch,
	DEFAULT_PAGE_SIZE,
} from './column-defaults.js';
import { stateOf } from './layout.js';

describe('parseColumnDefaults', () => {
	test('reads the order and the pinned columns the server put in the page', () => {
		expect(
			parseColumnDefaults('{"order":["url","meta:title"],"pinned":["meta:title"]}'),
		).toEqual({ order: ['url', 'meta:title'], pinned: ['meta:title'] });
	});

	test('an empty list is kept: no column is pinned', () => {
		expect(parseColumnDefaults('{"pinned":[]}')).toEqual({ pinned: [] });
	});

	test('an empty object, nothing, and text that is not JSON give no defaults', () => {
		expect(parseColumnDefaults('{}')).toEqual({});
		expect(parseColumnDefaults()).toEqual({});
		expect(parseColumnDefaults('')).toEqual({});
		// The page as it is before the server has put the defaults in it.
		expect(parseColumnDefaults('__KAMADO_COLUMN_DEFAULTS__')).toEqual({});
	});

	test('what is not an object of lists of texts is not read', () => {
		for (const text of ['null', '[]', '1', '"order"']) {
			expect(parseColumnDefaults(text)).toEqual({});
		}
		expect(parseColumnDefaults('{"order":"url","pinned":{}}')).toEqual({});
		expect(parseColumnDefaults('{"order":["url",1,null,"meta:a"]}')).toEqual({
			order: ['url', 'meta:a'],
		});
	});

	test('a field the screen does not know is dropped', () => {
		expect(parseColumnDefaults('{"order":["url"],"widths":{"url":10}}')).toEqual({
			order: ['url'],
		});
	});
});

describe('resetPatch', () => {
	test('puts back everything this project keeps, as the settings API takes it', () => {
		expect(resetPatch()).toEqual({
			project: { columns: null, sort: null, kinds: null, pageSize: DEFAULT_PAGE_SIZE },
		});
		expect(DEFAULT_PAGE_SIZE).toBe(500);
	});

	test('does not touch the language, which belongs to every project', () => {
		expect(resetPatch()).not.toHaveProperty('global');
	});
});

describe('resetOf', () => {
	test('is what a person who has set nothing sees: no sort, no kinds, the default rows per page', () => {
		const reset = resetOf();
		expect(reset.columnState).toEqual(stateOf());
		expect(reset.sort).toBeNull();
		expect(reset.kinds).toEqual({});
		expect(reset.pageSize).toBe(500);
	});

	test('lays the columns out by the defaults of the config when it has some', () => {
		const defaults = { order: ['url', 'meta:title'], pinned: ['meta:title'] };
		expect(resetOf(defaults).columnState).toEqual(stateOf(undefined, defaults));
		expect(resetOf(defaults).columnState.defaultPinned).toEqual(['meta:title']);
		expect(resetOf(defaults).columnState.pinned).toBeUndefined();
		expect(resetOf(defaults).columnState.order).toBeUndefined();
	});

	test('saves the same four things it puts back, whatever the defaults are', () => {
		expect(resetOf({ pinned: ['url'] }).patch).toEqual(resetPatch());
		expect(Object.keys(resetOf().patch.project ?? {}).toSorted()).toEqual([
			'columns',
			'kinds',
			'pageSize',
			'sort',
		]);
	});
});
