import { describe, expect, test } from 'vitest';

import { choicesOf, enumKindOf, optionsFromFiles } from './kinds.js';

describe('enumKindOf with the layouts of the site', () => {
	test('the layout column chooses among the files of the layouts directory', () => {
		expect(enumKindOf(undefined, 'meta:layout', ['sub', 'sub-with-side'])).toEqual({
			type: 'enum',
			options: ['sub', 'sub-with-side'],
		});
	});

	test('the files win over the options the settings kept', () => {
		const kept = { 'meta:layout': { type: 'enum' as const, options: ['old'] } };
		expect(enumKindOf(kept, 'meta:layout', ['sub'])).toEqual({
			type: 'enum',
			options: ['sub'],
		});
	});

	test('a layouts directory with no layout is a column with no option to choose', () => {
		expect(enumKindOf(undefined, 'meta:layout', [])).toEqual({
			type: 'enum',
			options: [],
		});
	});

	test('without a layouts directory the column is what the settings say', () => {
		expect(enumKindOf(undefined, 'meta:layout', null)).toBeUndefined();
		expect(enumKindOf(undefined, 'meta:layout')).toBeUndefined();
		const kept = { 'meta:layout': { type: 'enum' as const, options: ['old'] } };
		expect(enumKindOf(kept, 'meta:layout', null)).toEqual(kept['meta:layout']);
	});

	test('no other column takes the layouts', () => {
		expect(enumKindOf(undefined, 'meta:title', ['sub'])).toBeUndefined();
		expect(enumKindOf(undefined, 'meta:layouts', ['sub'])).toBeUndefined();
		expect(enumKindOf(undefined, 'url', ['sub'])).toBeUndefined();
	});
});

describe('optionsFromFiles', () => {
	test('is true for the layout column when the site has a layouts directory', () => {
		expect(optionsFromFiles('meta:layout', ['a'])).toBe(true);
		expect(optionsFromFiles('meta:layout', [])).toBe(true);
	});

	test('is false without one, and for the other columns', () => {
		expect(optionsFromFiles('meta:layout', null)).toBe(false);
		expect(optionsFromFiles('meta:layout')).toBe(false);
		expect(optionsFromFiles('meta:title', ['a'])).toBe(false);
	});
});

describe('a layout column whose value is not among the files', () => {
	test('shows the value it holds, and offers the files', () => {
		const kind = enumKindOf(undefined, 'meta:layout', ['sub', 'sub-with-side']);
		expect(choicesOf(kind?.options ?? [], 'removed')).toEqual([
			'sub',
			'sub-with-side',
			'removed',
		]);
	});

	test('with no file at all, offers only the value it holds', () => {
		const kind = enumKindOf(undefined, 'meta:layout', []);
		expect(choicesOf(kind?.options ?? [], 'removed')).toEqual(['removed']);
		expect(choicesOf(kind?.options ?? [])).toEqual([]);
	});
});
