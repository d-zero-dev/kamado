import { describe, expect, test } from 'vitest';

import { parseJobs } from './jobs.js';

describe('parseJobs', () => {
	test('a flag that was not given leaves the number to the core', () => {
		expect(parseJobs()).toBeUndefined();
	});

	test('auto leaves the number to the core', () => {
		expect(parseJobs('auto')).toBeUndefined();
	});

	test('a positive integer is the number of jobs', () => {
		expect(parseJobs('4')).toBe(4);
	});

	test.each(['0', '-1', '1.5', 'many', ''])('%j is refused', (text) => {
		expect(() => parseJobs(text)).toThrow(
			`--jobs must be a positive integer or "auto": ${text}`,
		);
	});
});
