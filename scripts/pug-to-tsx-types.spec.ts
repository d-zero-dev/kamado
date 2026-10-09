import { readFileSync } from 'node:fs';
import path from 'node:path';

// The converter reads the Pug code with the acorn of the project that it converts. The
// repository has it only through its linters (espree), so the import is not a declared one.

import * as acorn from 'acorn';
import { describe, expect, test } from 'vitest';

import { readPropNames, render } from './generate-react-prop-names.mjs';
import {
	falseBranchesToUndefined,
	isIdentifierUsed,
	jsxDeclarations,
	literalKeys,
	pruneUnusedImports,
	typedExpression,
	typedProgram,
} from './pug-to-tsx-types.mjs';
import { REACT_PROP_NAMES } from './react-prop-names.mjs';

const program = (code: string) => acorn.parse(code, { ecmaVersion: 'latest' });

describe('isIdentifierUsed', () => {
	test('finds a name as a whole', () => {
		expect(isIdentifierUsed('<A {...props} />', 'props')).toBe(true);
		expect(isIdentifierUsed('f(props, x)', 'props')).toBe(true);
		expect(isIdentifierUsed('<Meta />', 'Meta')).toBe(true);
	});

	test('does not take a part of another name', () => {
		expect(isIdentifierUsed('MetaBody', 'Meta')).toBe(false);
		expect(isIdentifierUsed('allprops', 'props')).toBe(false);
		expect(isIdentifierUsed('props2', 'props')).toBe(false);
	});

	test('does not take the property of an object for the name', () => {
		expect(isIdentifierUsed('a.props.b', 'props')).toBe(false);
		expect(isIdentifierUsed('x[0].props', 'props')).toBe(false);
		expect(isIdentifierUsed('f().props', 'props')).toBe(false);
	});

	test('takes a name that has a dollar sign', () => {
		expect(isIdentifierUsed('list.map(($item) => $item)', '$item')).toBe(true);
		expect(isIdentifierUsed('a$item', '$item')).toBe(false);
		expect(isIdentifierUsed('$items', '$item')).toBe(false);
	});
});

describe('typedExpression', () => {
	test('types the parameters of an arrow function in parentheses', () => {
		expect(typedExpression('items.map((a, i) => a + i)', acorn)).toBe(
			'items.map((a: any, i: any) => a + i)',
		);
	});

	test('types the one parameter of an arrow function without parentheses', () => {
		expect(typedExpression('list.filter(x => x)', acorn)).toBe(
			'list.filter((x: any) => x)',
		);
		expect(typedExpression('list.map(async x => x)', acorn)).toBe(
			'list.map(async (x: any) => x)',
		);
	});

	test('types a function expression', () => {
		expect(typedExpression('list.map(function (a) { return a; })', acorn)).toBe(
			'list.map(function (a: any) { return a; })',
		);
	});

	test('types a pattern, a default and a rest parameter', () => {
		expect(typedExpression('a.map(({ x }) => x)', acorn)).toBe(
			'a.map(({ x }: any) => x)',
		);
		expect(typedExpression('a.map(([x]) => x)', acorn)).toBe('a.map(([x]: any) => x)');
		expect(typedExpression('a.map((x = 1) => x)', acorn)).toBe(
			'a.map((x: any = 1) => x)',
		);
		expect(typedExpression('f((...r) => r)', acorn)).toBe('f((...r: any[]) => r)');
	});

	test('types the functions inside functions', () => {
		expect(typedExpression('a.map((x) => x.map((y) => y))', acorn)).toBe(
			'a.map((x: any) => x.map((y: any) => y))',
		);
	});

	test('does not touch the text of a string, a template or a comment', () => {
		expect(typedExpression('"click a => b"', acorn)).toBe('"click a => b"');
		expect(typedExpression('"(a) => 1"', acorn)).toBe('"(a) => 1"');
		expect(typedExpression('`x => ${y}`', acorn)).toBe('`x => ${y}`');
		expect(typedExpression('f(/* (a) => a */ 1)', acorn)).toBe('f(/* (a) => a */ 1)');
	});

	test('types the function inside a template', () => {
		expect(typedExpression('`${a.map(x => x)}`', acorn)).toBe(
			'`${a.map((x: any) => x)}`',
		);
	});

	test('leaves a call, a comparison and a text that is not an expression', () => {
		expect(typedExpression('f(a, b) >= 1 ? g(c) : d', acorn)).toBe(
			'f(a, b) >= 1 ? g(c) : d',
		);
		expect(typedExpression('a ? (b : c', acorn)).toBe('a ? (b : c');
		expect(typedExpression('a; b', acorn)).toBe('a; b');
	});

	test('does not type a parameter twice', () => {
		// The TypeScript it writes is not JavaScript to read again: it is left as it is.
		const once = typedExpression('a.map((x) => x)', acorn);
		expect(typedExpression(once, acorn)).toBe(once);
	});
});

describe('typedProgram', () => {
	test('types the functions of the statements and the constants of an object literal', () => {
		const code = 'const sources = { a: 1 }; const f = (x) => x;';
		expect(typedProgram(code, program(code))).toBe(
			'const sources: Record<string, any> = { a: 1 }; const f = (x: any) => x;',
		);
	});

	test('types every one of several declarations, from the end so that the offsets hold', () => {
		const code = 'const a = {}, b = {};';
		expect(typedProgram(code, program(code))).toBe(
			'const a: Record<string, any> = {}, b: Record<string, any> = {};',
		);
	});

	test('types a let and a var of an object literal', () => {
		const code = 'let a = {}; var b = { c: 1 };';
		expect(typedProgram(code, program(code))).toBe(
			'let a: Record<string, any> = {}; var b: Record<string, any> = { c: 1 };',
		);
	});

	test('leaves the other initialisers, a pattern and a statement that does not declare', () => {
		for (const code of [
			'const a = [1];',
			'const { a } = {};',
			'let a;',
			'x = { a: 1 };',
		]) {
			expect(typedProgram(code, program(code))).toBe(code);
		}
	});

	test('types a function declaration', () => {
		const code = 'function f(a, b) { return a + b; }';
		expect(typedProgram(code, program(code))).toBe(
			'function f(a: any, b: any) { return a + b; }',
		);
	});

	test('does not touch the text of a string', () => {
		const code = 'const s = "x => y";';
		expect(typedProgram(code, program(code))).toBe(code);
	});
});

describe('falseBranchesToUndefined', () => {
	test('writes the false of the branches of a condition as undefined', () => {
		expect(falseBranchesToUndefined('lang === "en" ? "_blank" : false', acorn)).toBe(
			'lang === "en" ? "_blank" : undefined',
		);
		expect(falseBranchesToUndefined('a ? false : "x"', acorn)).toBe(
			'a ? undefined : "x"',
		);
	});

	test('goes down the nested conditions', () => {
		expect(falseBranchesToUndefined('a ? "x" : b ? "y" : false', acorn)).toBe(
			'a ? "x" : b ? "y" : undefined',
		);
	});

	test('takes a condition in parentheses and a condition with two false branches', () => {
		expect(falseBranchesToUndefined('(a ? "x" : false)', acorn)).toBe(
			'(a ? "x" : undefined)',
		);
		expect(falseBranchesToUndefined('a ? false : false', acorn)).toBe(
			'a ? undefined : undefined',
		);
	});

	test('leaves a false that is not a branch of the condition', () => {
		expect(falseBranchesToUndefined('f(a ? 1 : false)', acorn)).toBe('f(a ? 1 : false)');
		expect(falseBranchesToUndefined('a === false', acorn)).toBe('a === false');
		expect(falseBranchesToUndefined('false', acorn)).toBe('false');
		expect(falseBranchesToUndefined('a && "x"', acorn)).toBe('a && "x"');
		expect(falseBranchesToUndefined('a ? null : "x"', acorn)).toBe('a ? null : "x"');
	});

	test('leaves what is not an expression of JavaScript', () => {
		expect(falseBranchesToUndefined('a ? (b : false', acorn)).toBe('a ? (b : false');
	});
});

describe('literalKeys', () => {
	test('lists the keys of an object literal', () => {
		expect(literalKeys('{ lang, a: 1, "b-c": 2 }', acorn)).toEqual(['lang', 'a', 'b-c']);
	});

	test('takes a number as a key, a method and a getter', () => {
		expect(literalKeys('{ 1: x, f() {}, get g() { return 1; } }', acorn)).toEqual([
			'1',
			'f',
			'g',
		]);
	});

	test('knows nothing of a spread, a computed key or another expression', () => {
		expect(literalKeys('{ lang, ...rest }', acorn)).toEqual([]);
		expect(literalKeys('{ [key]: 1 }', acorn)).toEqual([]);
		expect(literalKeys('props', acorn)).toEqual([]);
		expect(literalKeys('{ a: ', acorn)).toEqual([]);
	});
});

describe('pruneUnusedImports', () => {
	test('drops the names that nothing uses, and a line with no name left', () => {
		const text = [
			"import { html, m } from 'kamado/jsx';",
			"import { A, B } from './a.tsx';",
			"import { C } from './c.tsx';",
			"import D from './d.tsx';",
			"import E from './e.tsx';",
			'',
			'const x = <A>{html(1)}<E /></A>;',
		].join('\n');
		expect(pruneUnusedImports(text)).toBe(
			[
				"import { html } from 'kamado/jsx';",
				"import { A } from './a.tsx';",
				"import E from './e.tsx';",
				'',
				'const x = <A>{html(1)}<E /></A>;',
			].join('\n'),
		);
	});

	test('a name that is only part of another name is not used', () => {
		const text = ["import { Meta } from './m.tsx';", '', 'const x = MetaBody;'].join(
			'\n',
		);
		expect(pruneUnusedImports(text)).toBe(['', 'const x = MetaBody;'].join('\n'));
	});

	test('a name that is only the property of an object is not used', () => {
		const text = ["import { Meta } from './m.tsx';", '', 'const x = props.Meta;'].join(
			'\n',
		);
		expect(pruneUnusedImports(text)).toBe(['', 'const x = props.Meta;'].join('\n'));
	});

	test('a name with a dollar sign is read as it is', () => {
		const text = ["import { $a, $b } from './m.tsx';", '', 'const x = $a;'].join('\n');
		expect(pruneUnusedImports(text)).toBe(
			["import { $a } from './m.tsx';", '', 'const x = $a;'].join('\n'),
		);
	});

	test('leaves a module that uses all of its imports, and a form that it does not read', () => {
		const text = [
			"import F from './f.tsx';",
			"import type { T } from './t.ts';",
			'',
			'const x = F;',
		].join('\n');
		expect(pruneUnusedImports(text)).toBe(text);
	});
});

describe('jsxDeclarations', () => {
	test('declares what the converted pages use and @types/react does not have', () => {
		const text = jsxDeclarations();
		expect(text).toContain("declare module 'react'");
		expect(text).toContain('command?: string | undefined;');
		expect(text).toContain('commandfor?: string | undefined;');
		expect(text).toContain('interface HtmlHTMLAttributes<T>');
		expect(text).toContain('static?: boolean | undefined;');
	});
});

describe('readPropNames', () => {
	const map = (lines: string[]) =>
		[
			'possibleStandardNames = {',
			...lines,
			'      },',
			'      warnedProperties = {},',
		].join('\n');

	test('reads the names that React spells differently, sorted', () => {
		expect(
			readPropNames(map(['        srcset: "srcSet",', '        datetime: "dateTime",'])),
		).toEqual([
			['datetime', 'dateTime'],
			['srcset', 'srcSet'],
		]);
	});

	test('reads a name in quotes, with a hyphen, a colon or a digit', () => {
		expect(
			readPropNames(
				map([
					'        "accept-charset": "acceptCharset",',
					'        "xlink:href": "xlinkHref",',
					'        k1: "k1Name",',
				]),
			),
		).toEqual([
			['accept-charset', 'acceptCharset'],
			['k1', 'k1Name'],
			['xlink:href', 'xlinkHref'],
		]);
	});

	test('leaves out a name that is spelt the same', () => {
		expect(readPropNames(map(['        alt: "alt",']))).toEqual([]);
	});

	test('leaves out the event handlers', () => {
		expect(readPropNames(map(['        onclick: "onClick",']))).toEqual([]);
	});

	test('fails loudly when the map is not found or a line is not understood', () => {
		expect(() => readPropNames('nothing here')).toThrow('not found');
		expect(() => readPropNames('possibleStandardNames = {\n  a: "b",')).toThrow(
			'end of possibleStandardNames',
		);
		expect(() => readPropNames(map(['        a: [1],']))).toThrow('not understood');
	});
});

describe('the table of React prop names', () => {
	const names = new Map(REACT_PROP_NAMES as [string, string][]);

	test('has the names that the types of @types/react ask for', () => {
		expect(names.get('datetime')).toBe('dateTime');
		expect(names.get('srcset')).toBe('srcSet');
		expect(names.get('colspan')).toBe('colSpan');
		expect(names.get('maxlength')).toBe('maxLength');
		expect(names.get('readonly')).toBe('readOnly');
	});

	test('has no event handler and no name that is already React spelling', () => {
		expect([...names.keys()].filter((name) => name.startsWith('on'))).toEqual([]);
		expect([...names].filter(([attribute, prop]) => attribute === prop)).toEqual([]);
	});

	test('is what the generator writes for the installed react-dom', () => {
		const dir = path.resolve(import.meta.dirname, '..', 'node_modules', 'react-dom');
		const source = readFileSync(
			path.join(dir, 'cjs', 'react-dom-server.node.development.js'),
			'utf8',
		);
		const version = JSON.parse(
			readFileSync(path.join(dir, 'package.json'), 'utf8'),
		).version;
		const committed = readFileSync(
			path.resolve(import.meta.dirname, 'react-prop-names.mjs'),
			'utf8',
		);
		// If this fails after react-dom was upgraded: node scripts/generate-react-prop-names.mjs
		expect(render(readPropNames(source), version)).toBe(committed);
	});

	test('the generated file is not read by cspell, which does not know the attribute names', () => {
		expect(render([['a', 'b']], '1.0.0')).toContain('// cspell:disable');
	});
});
