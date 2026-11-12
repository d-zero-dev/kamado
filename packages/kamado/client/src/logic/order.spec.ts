import { describe, expect, test } from 'vitest';

import { movesPage, ORDER_KEY, pageOfLocated } from './order.js';

describe('movesPage', () => {
	test('setting or removing order moves a page when the rows are in the order of the plan', () => {
		expect(movesPage({ op: 'set', key: ORDER_KEY, value: 3 }, null)).toBe(true);
		expect(movesPage({ op: 'delete', key: ORDER_KEY }, null)).toBe(true);
	});

	test('a sort of another column keeps the rows where they are', () => {
		expect(
			movesPage({ op: 'set', key: ORDER_KEY, value: 3 }, { key: 'url', desc: false }),
		).toBe(false);
		expect(
			movesPage({ op: 'delete', key: ORDER_KEY }, { key: 'meta:title', desc: true }),
		).toBe(false);
	});

	test.each([
		[{ op: 'set', key: 'title', value: 'A' }],
		[{ op: 'delete', key: 'title' }],
		[{ op: 'moveUrl', url: '/b/' }],
		[{ op: 'virtualize' }],
	] as const)('an edit of something else does not: %j', (change) => {
		expect(movesPage(change, null)).toBe(false);
	});
});

describe('pageOfLocated', () => {
	test('is the page of the window the core answered with when it is not the one asked for', () => {
		expect(pageOfLocated(0, 200, 100)).toBe(2);
		expect(pageOfLocated(300, 0, 100)).toBe(0);
		expect(pageOfLocated(0, 5000, 5000)).toBe(1);
	});

	test('is nothing when the window is the one asked for', () => {
		expect(pageOfLocated(100, 100, 100)).toBeNull();
		expect(pageOfLocated(0, 0, 500)).toBeNull();
	});

	test('is nothing for a page size that is no size', () => {
		expect(pageOfLocated(0, 10, 0)).toBeNull();
	});
});
