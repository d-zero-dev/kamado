import { describe, expect, test } from 'vitest';

import {
	choicesOf,
	enumKindOf,
	kindsBytes,
	kindsPatch,
	MAX_ENUM_OPTION_LENGTH,
	MAX_ENUM_OPTIONS,
	MAX_KINDS_BYTES,
	mergeOptions,
	optionLabel,
	optionOf,
	optionsFromValues,
	optionsProblem,
	sameSelection,
	selectedOf,
	toggled,
	withKind,
} from './kinds.js';

describe('choicesOf', () => {
	test('are the options, and then the values of the cell that are not among them', () => {
		expect(choicesOf(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
		expect(choicesOf(['a'], ['b', 'a', 'c'])).toEqual(['a', 'b', 'c']);
	});

	test('are only the options when the cell has no value, or has one that is an option', () => {
		expect(choicesOf(['a', 'b'])).toEqual(['a', 'b']);
		expect(choicesOf(['a', 'b'], null)).toEqual(['a', 'b']);
		expect(choicesOf(['a', 'b'], 'b')).toEqual(['a', 'b']);
		expect(choicesOf(['a', 'b'], [])).toEqual(['a', 'b']);
	});

	test('tell the number 1 from the text "1", and a value that is not text, a number or a boolean is not one', () => {
		expect(choicesOf([1], '1')).toEqual([1, '1']);
		expect(choicesOf(['1'], 1)).toEqual(['1', 1]);
		expect(choicesOf(['a'], [{ x: 1 }, null, 'b'])).toEqual(['a', 'b']);
		expect(choicesOf(['a'], { x: 1 })).toEqual(['a']);
	});

	test('do not repeat a value the cell holds twice', () => {
		expect(choicesOf(['a'], ['b', 'b'])).toEqual(['a', 'b']);
	});
});

describe('optionLabel', () => {
	test('is the option as it is written, so that the number 1 and the text "1" can be told apart', () => {
		expect(optionLabel('wide')).toBe('wide');
		expect(optionLabel(1)).toBe('1');
		expect(optionLabel(true)).toBe('true');
		expect(optionLabel('1')).toBe('"1"');
		expect(optionLabel(' 2.5 ')).toBe('" 2.5 "');
		expect(optionLabel('true')).toBe('"true"');
		expect(optionLabel('false')).toBe('"false"');
		expect(optionLabel('')).toBe('');
	});
});

describe('selectedOf', () => {
	test('is the items of an array, a value that is one, or nothing', () => {
		expect(selectedOf(['x', 1])).toEqual(['x', 1]);
		expect(selectedOf('x')).toEqual(['x']);
		expect(selectedOf(false)).toEqual([false]);
		expect(selectedOf(null)).toEqual([]);
		expect(selectedOf()).toEqual([]);
		expect(selectedOf({ a: 1 })).toEqual([]);
	});
});

describe('toggled', () => {
	test('adds an option in the order of the choices, whatever order it was chosen in', () => {
		expect(toggled(['a', 'b', 'c'], ['c'], 'a')).toEqual(['a', 'c']);
		expect(toggled(['a', 'b', 'c'], ['a', 'c'], 'b')).toEqual(['a', 'b', 'c']);
	});

	test('takes an option away', () => {
		expect(toggled(['a', 'b', 'c'], ['a', 'b'], 'a')).toEqual(['b']);
		expect(toggled(['a'], ['a'], 'a')).toEqual([]);
	});

	test('treats 1 and "1" as two options', () => {
		expect(toggled([1, '1'], [1], '1')).toEqual([1, '1']);
		expect(toggled([1, '1'], [1, '1'], 1)).toEqual(['1']);
	});
});

describe('optionsProblem', () => {
	test('is null for options that can be kept', () => {
		expect(optionsProblem(['a', 1, true, ''])).toBeNull();
		expect(optionsProblem(['x'.repeat(MAX_ENUM_OPTION_LENGTH)])).toBeNull();
		expect(
			optionsProblem(Array.from({ length: MAX_ENUM_OPTIONS }, (_, n) => `v${n}`)),
		).toBeNull();
	});

	test('says what is wrong with options that cannot', () => {
		expect(optionsProblem([])).toBe('none');
		expect(
			optionsProblem(Array.from({ length: MAX_ENUM_OPTIONS + 1 }, (_, n) => `v${n}`)),
		).toBe('tooMany');
		expect(optionsProblem(['x'.repeat(MAX_ENUM_OPTION_LENGTH + 1)])).toBe('tooLong');
		expect(optionsProblem(['a', 'a'])).toBe('duplicate');
		expect(optionsProblem([1, 1])).toBe('duplicate');
		expect(optionsProblem([1, '1'])).toBeNull();
		expect(optionsProblem([Number.NaN])).toBe('invalid');
		expect(optionsProblem([Number.POSITIVE_INFINITY])).toBe('invalid');
	});
});

describe('kindsBytes', () => {
	test('are the bytes of the kinds as the server counts them, as JSON in UTF-8', () => {
		const kinds = { 'meta:a': { type: 'enum' as const, options: ['あ', 'b', 1, true] } };
		expect(kindsBytes(kinds)).toBe(
			new TextEncoder().encode(JSON.stringify(kinds)).length,
		);
		expect(kindsBytes({})).toBe(2);
	});

	test('stay in the budget with the options of the other columns counted', () => {
		const other = {
			'meta:other': {
				type: 'enum' as const,
				options: Array.from({ length: 100 }, (_, n) => `${'x'.repeat(100)}${n}`),
			},
		};
		expect(kindsBytes(other)).toBeGreaterThan(MAX_KINDS_BYTES / 2);
		expect(
			optionsProblem(
				Array.from({ length: 100 }, (_, n) => `${'y'.repeat(100)}${n}`),
				'meta:a',
				other,
			),
		).toBe('bytes');
		expect(optionsProblem(['a'], 'meta:a', other)).toBeNull();
		// The column that is being set is not counted twice: its old options are replaced.
		expect(optionsProblem(['a'], 'meta:other', other)).toBeNull();
	});
});

describe('withKind and kindsPatch', () => {
	const kinds = {
		'meta:a': { type: 'enum' as const, options: ['x'] },
		'meta:b': { type: 'enum' as const, options: ['y'] },
	};

	test('puts a kind in, replacing the one the column had, and leaves the others', () => {
		expect(withKind(kinds, 'meta:a', ['p', 'q'])).toEqual({
			'meta:a': { type: 'enum', options: ['p', 'q'] },
			'meta:b': { type: 'enum', options: ['y'] },
		});
		expect(withKind({}, 'meta:c', ['z'])).toEqual({
			'meta:c': { type: 'enum', options: ['z'] },
		});
	});

	test('takes a kind away with null, without changing the kinds it was given', () => {
		expect(withKind(kinds, 'meta:a', null)).toEqual({
			'meta:b': { type: 'enum', options: ['y'] },
		});
		expect(Object.keys(kinds)).toEqual(['meta:a', 'meta:b']);
		expect(withKind(kinds, 'meta:nothing', null)).toEqual(kinds);
	});

	test('keep a column called __proto__ as a column', () => {
		const next = withKind({}, 'meta:__proto__', ['z']);
		expect(Object.keys(next)).toEqual(['meta:__proto__']);
		expect(enumKindOf(next, 'meta:__proto__')).toEqual({ type: 'enum', options: ['z'] });
	});

	test('are sent as null when no column is an enum any more', () => {
		expect(kindsPatch({})).toBeNull();
		expect(kindsPatch(kinds)).toBe(kinds);
	});
});

describe('enumKindOf', () => {
	test('is the kind of a column that is an enum, and nothing for the others', () => {
		const kinds = { 'meta:a': { type: 'enum' as const, options: ['x'] } };
		expect(enumKindOf(kinds, 'meta:a')).toEqual({ type: 'enum', options: ['x'] });
		expect(enumKindOf(kinds, 'meta:b')).toBeUndefined();
		expect(enumKindOf(kinds, 'url')).toBeUndefined();
		expect(enumKindOf(undefined, 'meta:a')).toBeUndefined();
		// Not the prototype's `toString`.
		expect(enumKindOf(kinds, 'meta:toString')).toBeUndefined();
		expect(enumKindOf({}, 'constructor')).toBeUndefined();
	});
});

describe('optionsFromValues', () => {
	test('are the values of the core in its order, as options', () => {
		expect(
			optionsFromValues([
				{ value: 'wide', count: 5 },
				{ value: 1, count: 3 },
				{ value: true, count: 1 },
			]),
		).toEqual(['wide', 1, true]);
	});

	test('leave out what cannot be an option, and what repeats', () => {
		expect(
			optionsFromValues([
				{ value: 'a', count: 3 },
				{ value: 'a', count: 2 },
				{ value: null, count: 1 },
				// An option that is nothing is not offered (an empty choice would be a way to erase).
				{ value: '', count: 1 },
				{ value: { x: 1 }, count: 1 },
				{ value: 'x'.repeat(MAX_ENUM_OPTION_LENGTH + 1), count: 1 },
				{ value: Number.NaN, count: 1 },
			]),
		).toEqual(['a']);
	});

	test('stop at the most options there may be', () => {
		const values = Array.from({ length: MAX_ENUM_OPTIONS + 5 }, (_, n) => ({
			value: `v${n}`,
			count: 1,
		}));
		expect(optionsFromValues(values)).toHaveLength(MAX_ENUM_OPTIONS);
	});
});

describe('mergeOptions', () => {
	test('puts the values of the pages after the options, without repeating one', () => {
		const merged = mergeOptions(
			['a', 'x'],
			[
				{ value: 'a', count: 3 },
				{ value: 'b', count: 2 },
			],
			2,
		);
		expect(merged.options).toEqual(['a', 'x', 'b']);
		expect(merged.more).toBeNull();
	});

	test('says how many values the pages have when not all of them are options', () => {
		// Five different values; the request cut it to two, and one of those is an empty text.
		const merged = mergeOptions(
			[],
			[
				{ value: 'a', count: 3 },
				{ value: '', count: 2 },
			],
			5,
		);
		expect(merged.options).toEqual(['a']);
		expect(merged.more).toEqual({ total: 5, shown: 1 });
	});

	test('says so when the options are already as many as there may be and nothing is added', () => {
		const keep = Array.from({ length: MAX_ENUM_OPTIONS }, (_, n) => `k${n}`);
		const merged = mergeOptions(keep, [{ value: 'new', count: 1 }], 1);
		expect(merged.options).toEqual(keep);
		expect(merged.more).toEqual({ total: 1, shown: 0 });
	});

	test('counts a value of the pages that is an option already as shown', () => {
		const merged = mergeOptions(['a'], [{ value: 'a', count: 1 }], 1);
		expect(merged.more).toBeNull();
	});
});

describe('sameSelection', () => {
	test('is true for the same options in any order', () => {
		expect(sameSelection(['b', 'a'], ['a', 'b'])).toBe(true);
		expect(sameSelection([], [])).toBe(true);
	});

	test('is false when an option is added, taken away, or is another type', () => {
		expect(sameSelection(['a'], ['a', 'b'])).toBe(false);
		expect(sameSelection(['a', 'b'], ['a'])).toBe(false);
		expect(sameSelection([1], ['1'])).toBe(false);
	});
});

describe('optionOf', () => {
	test('is text as it is typed, and not empty', () => {
		expect(optionOf('wide', 'text')).toEqual({ ok: true, value: 'wide' });
		expect(optionOf(' padded ', 'text')).toEqual({ ok: true, value: ' padded ' });
		expect(optionOf('', 'text')).toEqual({ ok: false, reason: 'empty' });
	});

	test('is a number when it reads as one', () => {
		expect(optionOf(' 12.5 ', 'number')).toEqual({ ok: true, value: 12.5 });
		expect(optionOf('-3', 'number')).toEqual({ ok: true, value: -3 });
		expect(optionOf('abc', 'number')).toEqual({ ok: false, reason: 'number' });
		expect(optionOf('1e999', 'number')).toEqual({ ok: false, reason: 'number' });
		expect(optionOf('', 'number')).toEqual({ ok: false, reason: 'empty' });
	});

	test('is a boolean only for the words true and false', () => {
		expect(optionOf('true', 'boolean')).toEqual({ ok: true, value: true });
		expect(optionOf(' false ', 'boolean')).toEqual({ ok: true, value: false });
		expect(optionOf('yes', 'boolean')).toEqual({ ok: false, reason: 'boolean' });
		expect(optionOf('', 'boolean')).toEqual({ ok: false, reason: 'empty' });
	});
});
