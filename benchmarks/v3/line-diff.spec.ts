import { describe, expect, test } from 'vitest';

import { lineDiff } from './line-diff.ts';

describe('lineDiff', () => {
	test('equal inputs have no difference', () => {
		expect(lineDiff(['a', 'b'], ['a', 'b'])).toEqual([]);
	});

	test('changed lines are reported with their neighbours as context', () => {
		expect(lineDiff(['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'x', 'd', 'e'], 1)).toEqual([
			' b',
			'-c',
			'+x',
			' d',
		]);
	});

	test('separate changes are separated by a marker', () => {
		const a = ['1', 'a', '2', '3', '4', '5', 'b', '6'];
		const b = ['1', 'A', '2', '3', '4', '5', 'B', '6'];
		expect(lineDiff(a, b, 0)).toEqual(['-a', '+A', '@@', '-b', '+B']);
	});

	test('an empty side is all added or all removed', () => {
		expect(lineDiff([], ['a'], 0)).toEqual(['+a']);
		expect(lineDiff(['a', 'b'], [], 0)).toEqual(['-a', '-b']);
	});

	test('three lines of context are shown by default', () => {
		const a = ['1', '2', '3', '4', 'x', '5', '6', '7', '8'];
		const b = ['1', '2', '3', '4', 'y', '5', '6', '7', '8'];
		expect(lineDiff(a, b)).toEqual([' 2', ' 3', ' 4', '-x', '+y', ' 5', ' 6', ' 7']);
	});

	test('a middle too large for the table is shown as removed and then added', () => {
		const a = Array.from({ length: 5000 }, (_, i) => `a${i}`);
		const b = Array.from({ length: 5000 }, (_, i) => `b${i}`);
		const lines = lineDiff(['same', ...a], ['same', ...b], 0);
		expect(lines).toHaveLength(10_000);
		expect(lines[0]).toBe('-a0');
		expect(lines[5000]).toBe('+b0');
	});

	test('inserted and removed lines are found against the common lines', () => {
		expect(lineDiff(['a', 'c'], ['a', 'b', 'c'], 0)).toEqual(['+b']);
		expect(lineDiff(['a', 'b', 'c'], ['a', 'c'], 0)).toEqual(['-b']);
	});
});
