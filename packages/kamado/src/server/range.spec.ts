import { describe, expect, test } from 'vitest';

import { byteRange } from './range.js';

describe('byteRange', () => {
	test.each([
		['bytes=0-1', { start: 0, end: 1 }],
		['bytes=0-0', { start: 0, end: 0 }],
		['bytes=10-', { start: 10, end: 99 }],
		// An end past the file is the end of the file.
		['bytes=90-500', { start: 90, end: 99 }],
		['bytes=-10', { start: 90, end: 99 }],
		// A suffix longer than the file is the whole file.
		['bytes=-500', { start: 0, end: 99 }],
		[' bytes=5-6 ', { start: 5, end: 6 }],
		['Bytes=5-6', { start: 5, end: 6 }],
	])('%s of 100 bytes is a part', (header, range) => {
		expect(byteRange(header, 100)).toEqual(range);
	});

	test.each(['bytes=100-', 'bytes=100-200', 'bytes=-0'])(
		'%s of 100 bytes cannot be satisfied',
		(header) => {
			expect(byteRange(header, 100)).toBe('unsatisfiable');
		},
	);

	test('any range of an empty file cannot be satisfied', () => {
		expect(byteRange('bytes=0-', 0)).toBe('unsatisfiable');
		expect(byteRange('bytes=-1', 0)).toBe('unsatisfiable');
	});

	// The whole file is sent for these.
	test.each([
		undefined,
		'',
		'bytes=-',
		'bytes=5-1',
		'bytes=0-1,5-6',
		'items=0-1',
		'bytes=a-b',
		'bytes 0-1',
	])('%s is ignored', (header) => {
		expect(byteRange(header, 100)).toBeNull();
	});
});
