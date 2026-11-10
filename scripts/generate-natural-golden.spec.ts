import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import { escape, GOLDEN_FILE, render, values } from './generate-natural-golden.mjs';

describe('generate-natural-golden', () => {
	test('natural_golden.tsv is what the generator writes', () => {
		// If this fails after @d-zero/shared or random.test-util.ts changed:
		// node scripts/generate-natural-golden.mjs
		expect(render()).toBe(readFileSync(GOLDEN_FILE, 'utf8'));
	});

	test('the values are each once and there are enough of them', () => {
		const { paths, strings } = values();
		expect(new Set(paths).size).toBe(paths.length);
		expect(new Set(strings).size).toBe(strings.length);
		expect(paths.length * paths.length + strings.length * strings.length).toBeGreaterThan(
			1000,
		);
	});

	test('a line has four fields whatever the values hold', () => {
		for (const line of render().trimEnd().split('\n')) {
			expect(line.split('\t')).toHaveLength(4);
		}
	});

	test('a backslash, a tab and a newline are escaped', () => {
		expect(escape('a\\b\tc\nd')).toBe(String.raw`a\\b\tc\nd`);
	});

	test('the pair the comparison has a cycle in is in the golden', () => {
		const lines = render().split('\n');
		expect(lines).toContain('num\t2a\t10b\t-1');
		expect(lines).toContain('num\t10b\t1c\t-1');
		expect(lines).toContain('num\t1c\t2a\t-1');
	});
});
