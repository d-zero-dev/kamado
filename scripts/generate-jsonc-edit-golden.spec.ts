import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import {
	cases,
	containers,
	expected,
	GOLDEN_FILE,
	render,
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
