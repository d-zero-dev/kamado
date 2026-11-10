import { describe, expect, test } from 'vitest';

import { cellOf, expectOf, metaColumns } from './columns.js';

describe('metaColumns', () => {
	test('the keys of the pages and the added ones, each once, in byte order', () => {
		expect(metaColumns(['layout', 'title'], ['Draft', 'title'])).toEqual([
			'Draft',
			'layout',
			'title',
		]);
	});
});

describe('expectOf', () => {
	test('is the three hashes of the page', () => {
		expect(expectOf({ hashes: { input: 'i', sidecar: null } }, 'o')).toEqual({
			input: 'i',
			sidecar: null,
			overrides: 'o',
		});
	});
});

describe('cellOf', () => {
	const row = {
		meta: { title: { value: 'A', origin: 'inFile', editable: true } },
	} as const;
	test('a key the page has is edited as its value is', () => {
		expect(cellOf(row, 'title', new Map())).toEqual({
			cell: row.meta.title,
			kind: 'text',
		});
	});
	test('a key the page lacks is edited as it was added, or as text', () => {
		expect(cellOf(row, 'draft', new Map([['draft', 'boolean']]))).toEqual({
			cell: undefined,
			kind: 'boolean',
		});
		expect(cellOf(row, 'other', new Map()).kind).toBe('text');
	});
	test('a key named like a property of every object is not one the page has', () => {
		expect(cellOf(row, 'constructor', new Map()).cell).toBeUndefined();
	});
});
