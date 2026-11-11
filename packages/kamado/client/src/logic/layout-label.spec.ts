import { describe, expect, test } from 'vitest';

import { english, translator } from '../i18n/translate.js';

import { clashesWithFixedColumn, columnLabel, columnName } from './layout.js';

describe('clashesWithFixedColumn', () => {
	test.each(['meta:url', 'meta:virtual', 'meta:inputPath'])(
		'a key called %s has the name of a fixed column',
		(id) => {
			expect(clashesWithFixedColumn(id)).toBe(true);
		},
	);

	test('the fixed columns themselves and the other keys do not', () => {
		for (const id of [
			'url',
			'virtual',
			'inputPath',
			'meta:title',
			'meta:URL',
			'meta:urls',
		]) {
			expect(clashesWithFixedColumn(id)).toBe(false);
		}
	});
});

describe('columnLabel', () => {
	test.each([
		['meta:url', 'url'],
		['meta:virtual', 'virtual'],
		['meta:inputPath', 'inputPath'],
	])('the key %s is not shown by the name of the fixed column %s', (id, fixed) => {
		expect(columnLabel(id, english)).not.toBe(columnLabel(fixed, english));
		expect(columnLabel(id, english)).toBe(`${fixed} (meta)`);
		expect(columnLabel(id, translator('ja'))).toBe(`${fixed}（メタ）`);
	});

	test('a column that no fixed column is called like is shown by its name', () => {
		expect(columnLabel('url', english)).toBe('url');
		expect(columnLabel('meta:title', english)).toBe('title');
	});

	test('what is written is still the key', () => {
		expect(columnName('meta:url')).toBe('url');
	});
});
