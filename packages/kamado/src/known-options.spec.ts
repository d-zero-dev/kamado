import { describe, expect, test } from 'vitest';

import { assertKnownOptions } from './known-options.js';

describe('assertKnownOptions', () => {
	test('allows the empty object and every allowed key', () => {
		expect(() => assertKnownOptions({}, ['a', 'b'])).not.toThrow();
		expect(() => assertKnownOptions({ a: 1, b: 2 }, ['a', 'b'])).not.toThrow();
	});

	test('names the first key that is not allowed', () => {
		expect(() => assertKnownOptions({ a: 1, c: true }, ['a', 'b'])).toThrow(
			'unknown option: c',
		);
	});
});
