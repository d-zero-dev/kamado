import { describe, expect, test } from 'vitest';

import {
	ariaSortOf,
	canSort,
	columnKey,
	sameSort,
	sortAfterFailure,
	sortParams,
} from './sort.js';

describe('columnKey', () => {
	test('names the fixed columns by themselves and a key of the metadata with meta:', () => {
		expect(columnKey('url', true)).toBe('url');
		expect(columnKey('virtual', true)).toBe('virtual');
		expect(columnKey('inputPath', true)).toBe('inputPath');
		expect(columnKey('title', false)).toBe('meta:title');
		// A key of the metadata that is called like a fixed column is still a key of the metadata.
		expect(columnKey('url', false)).toBe('meta:url');
	});
});

describe('sameSort', () => {
	test('compares the column and the direction, and no sort with no sort', () => {
		expect(sameSort(null, null)).toBe(true);
		expect(sameSort(null, { key: 'url', desc: false })).toBe(false);
		expect(sameSort({ key: 'url', desc: false }, { key: 'url', desc: false })).toBe(true);
		expect(sameSort({ key: 'url', desc: false }, { key: 'url', desc: true })).toBe(false);
		expect(sameSort({ key: 'url', desc: false }, { key: 'virtual', desc: false })).toBe(
			false,
		);
	});
});

describe('sortAfterFailure', () => {
	test('lets go of a sort the server refuses and keeps it for any other failure', () => {
		const sort = { key: 'meta:x', desc: true };
		expect(sortAfterFailure(sort, 'invalidSort')).toBeNull();
		expect(sortAfterFailure(sort, 'network')).toBe(sort);
		// A bad offset or limit is not about the sort.
		expect(sortAfterFailure(sort, 'invalid')).toBe(sort);
		expect(sortAfterFailure(sort, 'failed')).toBe(sort);
		expect(sortAfterFailure(null, 'invalidSort')).toBeNull();
	});
});

describe('canSort', () => {
	test('is false for the name of a key that is empty, which the server refuses', () => {
		expect(canSort('meta:')).toBe(false);
		expect(canSort('meta:a')).toBe(true);
		expect(canSort('url')).toBe(true);
	});

	test('is false for an identifier the server would refuse for its length', () => {
		expect(canSort('meta:title')).toBe(true);
		expect(canSort(`meta:${'k'.repeat(251)}`)).toBe(true);
		expect(canSort(`meta:${'k'.repeat(252)}`)).toBe(false);
	});
});

describe('ariaSortOf', () => {
	test('is the direction for the sorted column and none for the others', () => {
		expect(ariaSortOf({ key: 'url', desc: false }, 'url')).toBe('ascending');
		expect(ariaSortOf({ key: 'url', desc: true }, 'url')).toBe('descending');
		expect(ariaSortOf({ key: 'url', desc: true }, 'virtual')).toBe('none');
		expect(ariaSortOf(null, 'url')).toBe('none');
	});
});

describe('sortParams', () => {
	test('is the parameters of the request, and nothing for no sort', () => {
		expect(sortParams(null)).toEqual({});
		expect(sortParams({ key: 'meta:title', desc: true })).toEqual({
			sort: 'meta:title',
			desc: 'true',
		});
		expect(sortParams({ key: 'url', desc: false })).toEqual({
			sort: 'url',
			desc: 'false',
		});
	});
});
