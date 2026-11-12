import { describe, expect, test } from 'vitest';

import { committedVersion, unformatted } from './generated-file.test-util.js';

describe('committedVersion', () => {
	const header = /^\/\/ Source: prettier (\S+) /mu;

	test.each([
		['the first line', '// Source: prettier 3.9.6 (plugins/html.mjs).\n'],
		['the second line', '// @generated\n// Source: prettier 3.9.6 (plugins/html.mjs).\n'],
		[
			'a later line',
			'// @generated\n//\n//\n// Source: prettier 3.9.6 (x).\nfn a() {}\n',
		],
	])('reads the version from the header on %s', (_, text) => {
		expect(committedVersion(text, header)).toBe('3.9.6');
	});

	test('fails, naming the header, when no line matches', () => {
		expect(() => committedVersion('// Source: esbuild 0.28.1 (x).\n', header)).toThrow(
			`no header line matches ${header}`,
		);
	});
});

describe('unformatted', () => {
	test('is the same for the code before and after cargo fmt', () => {
		expect(unformatted('pub static A: [&str; 2] = [\n\t"a",\n\t"b",\n];\n')).toBe(
			unformatted('pub static A: [&str; 2] = ["a", "b"];'),
		);
	});

	test('keeps the white space and the commas inside a string literal', () => {
		expect(unformatted('("a , ]", "\\" ,)")')).toBe('("a , ]","\\" ,)")');
	});
});
