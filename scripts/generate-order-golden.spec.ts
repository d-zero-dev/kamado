import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import { GOLDEN_FILE, orderOf, render, values } from './generate-order-golden.mjs';

describe('generate-order-golden', () => {
	test('order_golden.tsv is what the generator writes', () => {
		// If this fails after the engine or random.test-util.ts changed:
		// node scripts/generate-order-golden.mjs
		expect(render()).toBe(readFileSync(GOLDEN_FILE, 'utf8'));
	});

	test('the values are each once and there are enough of them', () => {
		const strings = values();
		expect(new Set(strings).size).toBe(strings.length);
		expect(strings.length).toBeGreaterThan(100);
	});

	test('a line has two fields whatever the value holds', () => {
		for (const line of render().trimEnd().split('\n')) {
			expect(line.split('\t')).toHaveLength(2);
		}
	});

	test('a value is the number the engine reads, and 0 when that is not finite', () => {
		expect(orderOf('03')).toBe(3);
		expect(orderOf(' 2.5 ')).toBe(2.5);
		expect(orderOf('1e3')).toBe(1000);
		expect(orderOf('3abc')).toBe(3);
		expect(orderOf('0x10')).toBe(0);
		expect(orderOf('Infinity')).toBe(0);
		expect(orderOf('1e999')).toBe(0);
		expect(orderOf('abc')).toBe(0);
	});

	test('the spaces the engine skips are in the golden, and so is the one it does not', () => {
		const lines = render().split('\n');
		expect(lines).toContain(`${JSON.stringify('\uFEFF6')}\t6`);
		expect(lines).toContain(`${JSON.stringify('\u00857')}\t0`);
	});
});
