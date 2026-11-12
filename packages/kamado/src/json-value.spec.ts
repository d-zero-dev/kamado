import { describe, expect, test } from 'vitest';

import { jsonProblem } from './json-value.js';

describe('jsonProblem', () => {
	test.each([
		null,
		true,
		'text',
		0,
		-1.5,
		[],
		[1, 'a', null, [{ a: [] }]],
		{},
		{ a: { b: [1, 2] } },
		Object.create(null) as object,
	])('%j is JSON', (value) => {
		expect(jsonProblem(value)).toBeNull();
	});

	test.each([
		[undefined, '$ is undefined'],
		[() => 1, '$ is a function'],
		[Symbol('s'), '$ is a symbol'],
		[1n, '$ is a bigint'],
		[Number.NaN, '$ is NaN'],
		[Number.POSITIVE_INFINITY, '$ is Infinity'],
		[new Date(0), '$ is a Date'],
		[new Map(), '$ is a Map'],
		[{ a: [1, { b: undefined }] }, '$.a[1].b is undefined'],
	])('%s is not JSON: %s', (value, why) => {
		expect(jsonProblem(value)).toBe(why);
	});

	test('a class instance is named, because JSON.stringify would turn it into an object', () => {
		class Row {
			readonly id = 1;
		}

		expect(jsonProblem({ rows: [new Row()] })).toBe('$.rows[0] is a Row');
	});

	test('a value that contains itself is refused, and a value used twice is not', () => {
		const loop: Record<string, unknown> = {};
		loop['self'] = loop;
		const shared = { n: 1 };

		expect(jsonProblem(loop)).toBe('$.self refers to a value that contains it');
		expect(jsonProblem({ a: shared, b: shared })).toBeNull();
	});
});
