import { describe, expect, test } from 'vitest';

import { hasCode } from './v2-print.mjs';

describe('hasCode', () => {
	test.each([
		['a script', '<p>a</p><script>a()</script>'],
		['a script with attributes', '<SCRIPT type="module">a</SCRIPT>'],
		['a style element', '<style>a{}</style>'],
		['a style attribute', '<p style="color:red">a</p>'],
		['an event handler', '<a href="/" onclick="a()">a</a>'],
	])('%s is code', (_, html) => {
		expect(hasCode(html)).toBe(true);
	});

	test.each([
		['plain markup', '<p class="a">b</p>'],
		['a name that only starts like script', '<scripted>a</scripted>'],
		['an attribute that only contains "style"', '<p data-style="a">b</p>'],
		['text that looks like an event handler', '<p>a one=b</p>'],
		['text that looks like a style attribute', '<p>a style=b</p>'],
	])('%s is not code', (_, html) => {
		expect(hasCode(html)).toBe(false);
	});

	test('an event handler after an attribute of a tag is code', () => {
		expect(hasCode('<a href="/" class="b" onclick="a()">c</a>')).toBe(true);
	});
});
