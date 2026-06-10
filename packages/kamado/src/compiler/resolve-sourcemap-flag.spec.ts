import { describe, test, expect } from 'vitest';

import { resolveSourcemapFlag } from './resolve-sourcemap-flag.js';

describe('resolveSourcemapFlag', () => {
	test.each([
		[undefined, 'build', false],
		[undefined, 'serve', true],
		[true, 'build', true],
		[true, 'serve', true],
		[false, 'build', false],
		[false, 'serve', false],
		['onServer', 'build', false],
		['onServer', 'serve', true],
	] as const)('sourcemap=%j, mode=%s → %j', (sourcemap, mode, expected) => {
		expect(resolveSourcemapFlag(sourcemap, mode)).toBe(expected);
	});
});
