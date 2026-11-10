import { describe, expect, test } from 'vitest';

import {
	addItem,
	changeItem,
	itemsFromJson,
	kindToAdd,
	moveItem,
	removeItem,
	valuesOf,
} from './list-items.js';

describe('itemsFromJson', () => {
	test('makes an item of each text, number and boolean of an array, with its kind', () => {
		const items = itemsFromJson('["a",2,false,""]');
		expect(items?.map(({ kind, text }) => [kind, text])).toEqual([
			['text', 'a'],
			['number', '2'],
			['boolean', 'false'],
			['text', ''],
		]);
	});

	test('gives each item a number of its own', () => {
		const items = itemsFromJson('["a","a","a"]') ?? [];
		expect(new Set(items.map((item) => item.id)).size).toBe(3);
	});

	test('is an empty list for an empty array', () => {
		expect(itemsFromJson('[]')).toEqual([]);
	});

	test('is null for anything that is not an array of text, numbers and booleans', () => {
		for (const json of [
			'[null]',
			'[{"a":1}]',
			'[["a"]]',
			'{"a":1}',
			'"a"',
			'1',
			'',
			'[',
		]) {
			expect(itemsFromJson(json), json).toBeNull();
		}
	});
});

describe('valuesOf', () => {
	test('is the value of each item, by its kind', () => {
		const items = itemsFromJson('["a",2,false]') ?? [];
		expect(valuesOf(items)).toEqual({ ok: true, values: ['a', 2, false] });
	});

	test('reads a number or a boolean that was typed over', () => {
		let items = itemsFromJson('[1,true]') ?? [];
		items = changeItem(items, items[0]?.id ?? -1, ' 3.5 ');
		items = changeItem(items, items[1]?.id ?? -1, 'false');
		expect(valuesOf(items)).toEqual({ ok: true, values: [3.5, false] });
	});

	test('says which item is not a value yet', () => {
		let items = itemsFromJson('["a",1,2]') ?? [];
		items = changeItem(items, items[1]?.id ?? -1, '1e');
		expect(valuesOf(items)).toEqual({ ok: false, index: 1 });
		items = changeItem(items, items[1]?.id ?? -1, '');
		expect(valuesOf(items)).toEqual({ ok: false, index: 1 });
		items = changeItem(items, items[1]?.id ?? -1, '1e999');
		expect(valuesOf(items)).toEqual({ ok: false, index: 1 });
	});

	test('says which item is a boolean that is neither true nor false', () => {
		let items = itemsFromJson('[true]') ?? [];
		items = changeItem(items, items[0]?.id ?? -1, 'yes');
		expect(valuesOf(items)).toEqual({ ok: false, index: 0 });
	});

	test('keeps text as it is, spaces and the empty text included', () => {
		const items = itemsFromJson('["  a  ",""]') ?? [];
		expect(valuesOf(items)).toEqual({ ok: true, values: ['  a  ', ''] });
	});

	test('is an empty list for no items', () => {
		expect(valuesOf([])).toEqual({ ok: true, values: [] });
	});
});

describe('addItem and kindToAdd', () => {
	test('adds an item at the end, empty text, 0 or false by its kind', () => {
		let items = itemsFromJson('["a"]') ?? [];
		items = addItem(items, 'text');
		items = addItem(items, 'number');
		items = addItem(items, 'boolean');
		expect(items.map(({ kind, text }) => [kind, text])).toEqual([
			['text', 'a'],
			['text', ''],
			['number', '0'],
			['boolean', 'false'],
		]);
		expect(new Set(items.map((item) => item.id)).size).toBe(4);
	});

	test('is a text for the first item, and then the kind of the last item', () => {
		expect(kindToAdd([])).toBe('text');
		expect(kindToAdd(itemsFromJson('["a",1]') ?? [])).toBe('number');
		expect(kindToAdd(itemsFromJson('[true]') ?? [])).toBe('boolean');
	});

	test('does not change the items it was given', () => {
		const items = itemsFromJson('["a"]') ?? [];
		addItem(items, 'text');
		expect(items).toHaveLength(1);
	});
});

describe('removeItem and moveItem', () => {
	const make = () => itemsFromJson('["a","b","c"]') ?? [];
	const texts = (items: ReturnType<typeof make>) => items.map((item) => item.text);

	test('takes an item away by its number', () => {
		const items = make();
		expect(texts(removeItem(items, items[1]?.id ?? -1))).toEqual(['a', 'c']);
		expect(texts(items)).toEqual(['a', 'b', 'c']);
	});

	test('moves an item up or down by one, and not out of the list', () => {
		const items = make();
		const [a, b, c] = items.map((item) => item.id) as [number, number, number];
		expect(texts(moveItem(items, b, -1))).toEqual(['b', 'a', 'c']);
		expect(texts(moveItem(items, b, 1))).toEqual(['a', 'c', 'b']);
		expect(texts(moveItem(items, a, -1))).toEqual(['a', 'b', 'c']);
		expect(texts(moveItem(items, c, 1))).toEqual(['a', 'b', 'c']);
	});

	test('leave the list as it is for an item that is not there', () => {
		const items = make();
		expect(texts(removeItem(items, 999))).toEqual(['a', 'b', 'c']);
		expect(texts(moveItem(items, 999, 1))).toEqual(['a', 'b', 'c']);
	});
});
