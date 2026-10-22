import { describe, expect, test } from 'vitest';

import { blockEnd, dropRepeatedAtRules, joinAdjacentAtRules } from './css-compare.mjs';

describe('blockEnd', () => {
	test('returns the index after the closing brace', () => {
		expect(blockEnd('a{b:c}d', 2)).toBe(6);
	});

	test('follows nested blocks', () => {
		expect(blockEnd('a{b{c:d}}e', 2)).toBe(9);
	});

	test('skips a brace in a double-quoted string', () => {
		expect(blockEnd('a{content:"}"}x', 2)).toBe(14);
	});

	test('skips a brace in a single-quoted string with an escaped quote', () => {
		expect(blockEnd(String.raw`a{content:'\'}'}x`, 2)).toBe(
			String.raw`a{content:'\'}'}`.length,
		);
	});

	test('skips a brace in a comment', () => {
		expect(blockEnd('a{/* } */b:c}x', 2)).toBe(13);
	});

	test('skips an escaped brace', () => {
		expect(blockEnd(String.raw`a{b:\}c}x`, 2)).toBe(8);
	});

	test('returns -1 when the block is not closed', () => {
		expect(blockEnd('a{b:c', 2)).toBe(-1);
	});
});

describe('joinAdjacentAtRules', () => {
	test('joins neighbouring blocks with the same query', () => {
		expect(joinAdjacentAtRules('@media x{a{b:c}}@media x{d{e:f}}')).toBe(
			'@media x{a{b:c}d{e:f}}',
		);
	});

	test('joins neighbouring blocks of the same named layer', () => {
		expect(joinAdjacentAtRules('@layer a.b{c{d:e}}@layer a.b{f{g:h}}')).toBe(
			'@layer a.b{c{d:e}f{g:h}}',
		);
	});

	test('does not join blocks with another query or another layer name', () => {
		const css = '@media x{a{b:c}}@media y{d{e:f}}@layer p{g{h:i}}@layer q{j{k:l}}';

		expect(joinAdjacentAtRules(css)).toBe(css);
	});

	test('does not join anonymous layers, which are layers of their own', () => {
		const css = '@layer{a{b:c}}@layer{d{e:f}}';

		expect(joinAdjacentAtRules(css)).toBe(css);
	});

	test('does not join blocks with a rule between them', () => {
		const css = '@media x{a{b:c}}g{h:i}@media x{d{e:f}}';

		expect(joinAdjacentAtRules(css)).toBe(css);
	});

	test('finds the end of a block that holds a brace in a string', () => {
		expect(joinAdjacentAtRules('@media x{a{content:"}"}}@media x{b{c:d}}')).toBe(
			'@media x{a{content:"}"}b{c:d}}',
		);
	});
});

describe('dropRepeatedAtRules', () => {
	test('drops a block that repeats the block before it', () => {
		expect(dropRepeatedAtRules('@media x{a{b:c}}@media x{a{b:c}}')).toBe(
			'@media x{a{b:c}}',
		);
	});

	test('drops every repeat of a named layer', () => {
		expect(dropRepeatedAtRules('@layer a{b{c:d}}@layer a{b{c:d}}@layer a{b{c:d}}')).toBe(
			'@layer a{b{c:d}}',
		);
	});

	test('keeps blocks that differ', () => {
		const css = '@media x{a{b:c}}@media x{a{b:d}}';

		expect(dropRepeatedAtRules(css)).toBe(css);
	});

	test('keeps a block that repeats one with a rule between them', () => {
		const css = '@media x{a{b:c}}d{e:f}@media x{a{b:c}}';

		expect(dropRepeatedAtRules(css)).toBe(css);
	});

	test('keeps repeated anonymous layers, which are layers of their own', () => {
		const css = '@layer{a{b:c}}@layer{a{b:c}}';

		expect(dropRepeatedAtRules(css)).toBe(css);
	});
});
