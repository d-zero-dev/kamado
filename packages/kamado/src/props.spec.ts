import { describe, expect, test } from 'vitest';

import { basePathOf } from './props.js';

describe('basePathOf', () => {
	test.each([
		[null, '/'],
		['', '/'],
		['/sub/', '/sub/'],
		['https://example.com/sub/', '/sub/'],
		['https://example.com', '/'],
		['http://example.test/a/b/', '/a/b/'],
	])('%j is %j', (baseURL, expected) => {
		expect(basePathOf(baseURL)).toBe(expected);
	});
});
