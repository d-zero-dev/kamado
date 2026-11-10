import { describe, expect, test } from 'vitest';

import {
	defaultOf,
	draftOf,
	FIELD_KINDS,
	kindOf,
	parseDraft,
	sameValue,
} from './value.js';

describe('kindOf for an array', () => {
	test.each([
		[[], 'list'],
		[['a', 'b'], 'list'],
		[[1, 2.5], 'list'],
		[[true, false], 'list'],
		[['a', 1, true], 'list'],
		[[null], 'json'],
		[['a', null], 'json'],
		[[{ a: 1 }], 'json'],
		[[['a']], 'json'],
		[[{}], 'json'],
	] as const)('%j is edited as %s', (value, kind) => {
		expect(kindOf(value)).toBe(kind);
	});

	test('an object is JSON, as it was', () => {
		expect(kindOf({})).toBe('json');
		expect(kindOf({ a: ['x'] })).toBe('json');
	});
});

describe('draftOf for a list and an enum', () => {
	test('a list is its JSON, in one line, so that an unchanged list is the same text', () => {
		expect(draftOf(['a', 1, true], 'list')).toBe('["a",1,true]');
		expect(draftOf([], 'list')).toBe('[]');
		expect(draftOf(undefined, 'list')).toBe('[]');
	});

	test('an enum value is its JSON: a text is quoted, so that 1 and "1" are told apart', () => {
		expect(draftOf('wide', 'enum')).toBe('"wide"');
		expect(draftOf(1, 'enum')).toBe('1');
		expect(draftOf('1', 'enum')).toBe('"1"');
		expect(draftOf(false, 'enum')).toBe('false');
		expect(draftOf(['a', 'b'], 'enum')).toBe('["a","b"]');
	});

	test('an enum without a value starts as nothing', () => {
		expect(draftOf(undefined, 'enum')).toBe('');
		expect(draftOf(null, 'enum')).toBe('');
	});
});

describe('parseDraft for a list and an enum', () => {
	test('both read JSON, whatever it is: a list may be turned into JSON that is not a list', () => {
		expect(parseDraft('list', '["a",1]')).toEqual({ ok: true, value: ['a', 1] });
		expect(parseDraft('list', '[{"a":1}]')).toEqual({ ok: true, value: [{ a: 1 }] });
		expect(parseDraft('list', '{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
		expect(parseDraft('enum', '"wide"')).toEqual({ ok: true, value: 'wide' });
		expect(parseDraft('enum', '3')).toEqual({ ok: true, value: 3 });
		expect(parseDraft('enum', '["a"]')).toEqual({ ok: true, value: ['a'] });
	});

	test('text that is not JSON is not a value yet', () => {
		expect(parseDraft('list', '[').ok).toBe(false);
		expect(parseDraft('enum', '').ok).toBe(false);
		expect(parseDraft('enum', 'wide').ok).toBe(false);
	});

	test('an unchanged draft is the value that was there', () => {
		const value = ['a', 1];
		const draft = draftOf(value, 'list');
		const parsed = parseDraft('list', draft);
		expect(parsed.ok && sameValue(parsed.value, value)).toBe(true);
	});
});

describe('the kinds a key can be added as', () => {
	test('include a list, and not an enum (an enum is a choice made for a column)', () => {
		expect(FIELD_KINDS).toContain('list');
		expect(FIELD_KINDS).not.toContain('enum');
	});

	test('a key added as a list starts as an empty list', () => {
		expect(defaultOf('list')).toEqual([]);
	});
});
