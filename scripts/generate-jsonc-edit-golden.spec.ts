import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import {
	ARRAY_GOLDEN_FILE,
	arrayCases,
	cases,
	containers,
	expected,
	expectedPush,
	GOLDEN_FILE,
	render,
	renderArrays,
	without,
} from './generate-jsonc-edit-golden.mjs';

describe('generate-jsonc-edit-golden', () => {
	test('edit_golden.json is what the generator writes', () => {
		// If this fails after jsonc-parser was upgraded or a case was added:
		// node scripts/generate-jsonc-edit-golden.mjs
		expect(render()).toBe(readFileSync(GOLDEN_FILE, 'utf8'));
	});

	test('the cases set, add and delete keys, and there are enough of them', () => {
		const list = cases();
		expect(list.length).toBeGreaterThan(500);
		expect(new Set(list.map((c: { op: string }) => c.op))).toEqual(
			new Set(['set', 'delete']),
		);
	});

	test('edit_array_golden.json is what the generator writes', () => {
		// If this fails after jsonc-parser was upgraded or a case was added:
		// node scripts/generate-jsonc-edit-golden.mjs
		expect(renderArrays()).toBe(readFileSync(ARRAY_GOLDEN_FILE, 'utf8'));
	});

	test('the cases of arrays push and delete items, and there are enough of them', () => {
		const list = arrayCases();
		const count = (op: string) => list.filter((c: { op: string }) => c.op === op).length;
		// Each kind has its own floor: the pushes alone would hide the deletes going missing.
		expect(count('push')).toBeGreaterThanOrEqual(300);
		expect(count('deleteElement')).toBeGreaterThanOrEqual(20);
		expect(count('push') + count('deleteElement')).toBe(list.length);
	});

	test('the oracle adds an item after the last one of an array', () => {
		expect(expectedPush('{"a":[1]}', ['a'], 2)).toBe('{"a":[1,2]}');
		expect(expectedPush('[]', [], { k: 'v' })).toBe('[{"k":"v"}]');
		expect(expected('[1,2,3]', [1])).toBe('[1,3]');
	});

	test('a delete the oracle gets wrong is not a case', () => {
		// The last item of an array with no blank before its `]`. If this fails after
		// jsonc-parser was upgraded, the oracle removes the item now: take the check out of
		// `arrayCases`.
		expect(expected('[1, 2]', [1])).toBe('[12]');
		expect(without({ a: [1, 2] }, ['a'], 1)).toEqual({ a: [1] });
		expect(without([[1, 2], []], [0], 0)).toEqual([[2], []]);
		expect(
			arrayCases().some(
				(c: { text: string; op: string; index?: number }) =>
					c.text === '[[1, 2], [], [[3]]]' && c.op === 'deleteElement' && c.index === 1,
			),
		).toBe(true);
		expect(
			arrayCases().some(
				(c: { text: string; op: string; path: unknown[]; index?: number }) =>
					c.text === '[[1, 2], [], [[3]]]' &&
					c.op === 'deleteElement' &&
					c.path.length === 1 &&
					c.path[0] === 0 &&
					c.index === 1,
			),
		).toBe(false);
	});

	test('the containers of a value run from the root down', () => {
		expect(
			containers({ a: [1, { b: 2 }] }).map((c: { path: unknown }) => c.path),
		).toEqual([[], ['a'], ['a', 1]]);
		expect(containers('text')).toEqual([]);
	});

	test('the oracle reads its own result back as the value', () => {
		expect(expected('{"a":1}', ['a'], 2)).toBe('{"a":2}');
		expect(expected('{"a":1,"b":2}', ['a'])).toBe('{"b":2}');
		expect(expected('{ // c\n"a": 1,\n}', ['b'], 'x')).toBe('{"a":1,"b":"x"}');
	});
});
