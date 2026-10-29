import { describe, expect, test } from 'vitest';

import {
	cssnanoMinify,
	matchesWithDecisionsUndone,
	minifyNestedDeclarations,
	withoutNestedDeclarations,
} from './css-oracle.mjs';

describe('matchesWithDecisionsUndone', () => {
	// cssnano makes the invalid `0px 0% 0em` a valid `0` and drops the first
	// `border-width:0` as a repeat of it; kd_css keeps it invalid (`0 0%`),
	// which cssnano makes `0 0`, not a repeat.
	const input = 'a{border-width:0px}a{border-width:bold}a{border-width:0px 0% 0em}';
	const mine = 'a{border-width:0;border-width:bold;border-width:0 0%}';
	const undone = 'a{border-width:0;border-width:bold;border-width:0}';

	test('cssnano does not bring the output and the input to one', async () => {
		expect(await cssnanoMinify(input)).toBe('a{border-width:bold;border-width:0}');
		expect(await cssnanoMinify(mine)).toBe(
			'a{border-width:0;border-width:bold;border-width:0 0}',
		);
	});

	const same = (x: string, y: string) => x === y;

	test('matches once the decisions are undone on the output', async () => {
		const theirs = await cssnanoMinify(input);
		expect(await matchesWithDecisionsUndone([theirs], undone, same)).toEqual({
			matches: true,
		});
	});

	test('does not match an output with a difference beyond the decisions', async () => {
		const theirs = await cssnanoMinify(input);
		expect(
			await matchesWithDecisionsUndone(
				[theirs],
				'a{border-width:2px;border-width:bold;border-width:0}',
				same,
			),
		).toEqual({ matches: false });
	});

	test('compares the declarations of a rule with nested rules after cssnano minified them alike', async () => {
		// cssnano leaves a declaration in a block inside a rule less minified.
		const theirs = 'a{@media x{color:RED}}';
		expect(await cssnanoMinify('a{@media x{color:red}}')).not.toBe(theirs);
		expect(
			await matchesWithDecisionsUndone([theirs], 'a{@media x{color:red}}', same),
		).toEqual({ matches: true });
	});

	test('compares the values of the declarations of a rule with nested rules', async () => {
		expect(
			await matchesWithDecisionsUndone(
				['a{color:red;&:hover{x:1}}'],
				'a{color:blue;&:hover{x:1}}',
				same,
			),
		).toEqual({ matches: false });
	});

	test('matches any of the spellings it is given', async () => {
		expect(
			await matchesWithDecisionsUndone(['a{b:1}', 'a{b:0}'], 'a{b:0px}', same),
		).toEqual({ matches: true });
	});

	test('gives the reason when cssnano rejects what is undone', async () => {
		const result = await matchesWithDecisionsUndone(['a{b:c}'], 'a{b:"', same);
		expect(result.matches).toBe(false);
		expect(result.error).toMatch(/Unclosed/u);
	});
});

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

	test('marks a run of more than two declarations once', () => {
		expect(withoutNestedDeclarations('a{b:c;d:e;f:g;h:i;&:hover{j:k}}')).toBe(
			'a{/*d*/&:hover{/*d*/}}',
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
