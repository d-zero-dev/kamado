import { describe, expect, test } from 'vitest';

import { minifyNestedDeclarations, withoutNestedDeclarations } from './css-oracle.mjs';

describe('withoutNestedDeclarations', () => {
	test('leaves a rule without nested rules alone', () => {
		expect(withoutNestedDeclarations('a{b:c}')).toBe('a{b:c}');
	});

	test('marks each run of declarations of a rule with nested rules and of the blocks inside', () => {
		expect(withoutNestedDeclarations('a{b:c;&:hover{d:e;f:g}h:i}')).toBe(
			'a{/*d*/&:hover{/*d*/}/*d*/}',
		);
	});

	test('marks the declarations of a block inside a rule', () => {
		expect(withoutNestedDeclarations('a{@media x{b:c}}')).toBe('a{@media x{/*d*/}}');
	});

	test('does not compare the values of the declarations', () => {
		expect(withoutNestedDeclarations('a{color:red;&:hover{x:1}}')).toBe(
			withoutNestedDeclarations('a{color:blue;&:hover{x:2}}'),
		);
	});

	test('tells a missing run of declarations from a present one', () => {
		expect(withoutNestedDeclarations('a{color:red;&:hover{x:1}}')).not.toBe(
			withoutNestedDeclarations('a{&:hover{x:1}}'),
		);
	});

	test('tells where the declarations are among the nested rules', () => {
		expect(withoutNestedDeclarations('a{&:hover{}y:2}')).not.toBe(
			withoutNestedDeclarations('a{y:2;&:hover{}}'),
		);
	});

	test('marks the declarations after a nested at-rule as a run of their own', () => {
		expect(withoutNestedDeclarations('a{@media x{b:c}d:e}')).toBe(
			'a{@media x{/*d*/}/*d*/}',
		);
	});

	test('keeps the run together across a comment', () => {
		expect(withoutNestedDeclarations('a{b:c;/* k */d:e;&{f:g}}')).toBe(
			'a{/*d*//* k */&{/*d*/}}',
		);
	});
});

describe('minifyNestedDeclarations', () => {
	test('leaves the declarations of a rule without nested rules alone', async () => {
		expect(await minifyNestedDeclarations('a{color:RED}')).toBe('a{color:RED}');
	});

	test('minifies the declarations of a block inside a rule like cssnano does elsewhere', async () => {
		expect(await minifyNestedDeclarations('a{@media x{color:RED}}')).toBe(
			'a{@media x{color:red}}',
		);
	});

	test('minifies the declarations of a rule with nested rules', async () => {
		expect(await minifyNestedDeclarations('a{color:RED;&:hover{x:1;y:2}}')).toBe(
			'a{color:red;&:hover{x:1;y:2}}',
		);
	});

	test('keeps the declarations that cssnano gives back nothing for', async () => {
		expect(await minifyNestedDeclarations('a{@media x{color:}}')).toBe(
			'a{@media x{color:}}',
		);
	});

	test('minifies every block of a style sheet', async () => {
		expect(await minifyNestedDeclarations('a{@media x{color:RED}&{margin:0px}}')).toBe(
			'a{@media x{color:red}&{margin:0}}',
		);
	});

	test('keeps the values apart', async () => {
		expect(await minifyNestedDeclarations('a{color:red;&:hover{x:1}}')).not.toBe(
			await minifyNestedDeclarations('a{color:blue;&:hover{x:1}}'),
		);
	});
});
