import { describe, expect, test } from 'vitest';

import { defaultOf, draftOf, kindOf, parseDraft, sameValue, toText } from './value.js';

describe('kindOf', () => {
	test.each([
		[true, 'boolean'],
		[false, 'boolean'],
		[0, 'number'],
		[1.5, 'number'],
		['2026-01-02', 'date'],
		['2026-01-02T03:04:05', 'date'],
		['2026-01-02T03:04:05Z', 'date'],
		['2026-01-02T03:04:05.123Z', 'date'],
		['2026-01-02T03:04:05+09:00', 'text'],
		['2026-01-02 12:00', 'text'],
		['2026-01-02 is the day', 'text'],
		['2026-13-45', 'text'],
		['not a date', 'text'],
		['', 'text'],
		[null, 'text'],
		// Behavior change: an array of text, numbers and booleans is edited as a list, not as JSON
		[['a'], 'list'],
		// [['a'], 'json'], // previous
		[{ a: 1 }, 'json'],
	] as const)('%j is edited as %s', (value, kind) => {
		expect(kindOf(value)).toBe(kind);
	});
});

describe('toText', () => {
	test('null and a missing value are nothing', () => {
		expect(toText(null)).toBe('');
		const missing: unknown = [].find(Boolean);
		expect(toText(missing)).toBe('');
	});
	test('strings are as they are, scalars are written out', () => {
		expect(toText('a b')).toBe('a b');
		expect(toText(12)).toBe('12');
		expect(toText(false)).toBe('false');
	});
	test('arrays and objects are compact JSON', () => {
		expect(toText(['a', 1])).toBe('["a",1]');
		expect(toText({ a: { b: 2 } })).toBe('{"a":{"b":2}}');
	});
});

describe('draftOf', () => {
	test('a date input takes the day in UTC', () => {
		expect(draftOf('2026-01-02T23:00:00Z', 'date')).toBe('2026-01-02');
		expect(draftOf('2026-01-02', 'date')).toBe('2026-01-02');
	});
	test('a time without a zone does not move the day (it is not read through Date)', () => {
		// Read through `Date`, the first of these is the day before in a zone east of UTC and
		// the second the day after in a zone west of it.
		expect(draftOf('2026-01-02T00:00:00', 'date')).toBe('2026-01-02');
		expect(draftOf('2026-01-02T23:59:59', 'date')).toBe('2026-01-02');
	});
	test('JSON is indented for the text area', () => {
		expect(draftOf({ a: 1 }, 'json')).toBe('{\n  "a": 1\n}');
	});
	test('the rest is what the cell shows', () => {
		expect(draftOf(null, 'text')).toBe('');
		expect(draftOf(3, 'number')).toBe('3');
	});
});

describe('parseDraft', () => {
	test('text is the text', () => {
		expect(parseDraft('text', 'a')).toEqual({ ok: true, value: 'a' });
		expect(parseDraft('text', '')).toEqual({ ok: true, value: '' });
	});
	test('an empty number is null, a number is a number', () => {
		expect(parseDraft('number', '')).toEqual({ ok: true, value: null });
		expect(parseDraft('number', ' 12.5 ')).toEqual({ ok: true, value: 12.5 });
	});
	test('what is not a finite number is not a value yet (infinity is not JSON)', () => {
		expect(parseDraft('number', '1e999').ok).toBe(false);
		expect(parseDraft('number', 'abc').ok).toBe(false);
	});
	test('a boolean is true only for the text true', () => {
		expect(parseDraft('boolean', 'true')).toEqual({ ok: true, value: true });
		expect(parseDraft('boolean', 'false')).toEqual({ ok: true, value: false });
	});
	test('JSON is parsed and takes the type it is', () => {
		expect(parseDraft('json', '[1, 2]')).toEqual({ ok: true, value: [1, 2] });
		expect(parseDraft('json', '5')).toEqual({ ok: true, value: 5 });
		expect(parseDraft('json', '"s"')).toEqual({ ok: true, value: 's' });
	});
	test('JSON that does not parse says so and is not a value', () => {
		const parsed = parseDraft('json', '{');
		expect(parsed.ok).toBe(false);
	});
	test('a date is the day typed', () => {
		expect(parseDraft('date', '2026-01-02')).toEqual({ ok: true, value: '2026-01-02' });
	});
});

describe('sameValue', () => {
	test('values that write the same are the same', () => {
		expect(sameValue({ a: [1] }, { a: [1] })).toBe(true);
		expect(sameValue('a', 'a')).toBe(true);
	});
	test('null is not an empty string, and 0 is not false', () => {
		expect(sameValue(null, '')).toBe(false);
		expect(sameValue(0, false)).toBe(false);
	});
});

describe('defaultOf', () => {
	const now = new Date('2026-01-02T23:00:00Z');
	test.each([
		['text', ''],
		['number', 0],
		['boolean', false],
		['date', '2026-01-02'],
		['json', []],
	] as const)('a key added as %s starts as %j', (kind, value) => {
		expect(defaultOf(kind, now)).toEqual(value);
	});
});
