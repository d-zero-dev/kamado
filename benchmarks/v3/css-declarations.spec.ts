import { describe, expect, test } from 'vitest';

import { classAttributeSelectors, prefixDifference } from './css-declarations.ts';

describe('prefixDifference', () => {
	test('each declaration is keyed by the rules that enclose it', () => {
		expect(
			prefixDifference('@media (min-width:1px){a{-webkit-x:1;-webkit-y:2}}', '').removed,
		).toEqual([
			'@media (min-width:1px) > a { -webkit-x:1 }',
			'@media (min-width:1px) > a { -webkit-y:2 }',
		]);
	});

	test('semicolons and braces inside strings and parentheses do not split', () => {
		expect(
			prefixDifference(
				'a{background:-webkit-image-set(url(data:a;b,{x}) 1x);-webkit-content:"a;}b"}',
				'',
			).removed,
		).toEqual([
			'a { background:-webkit-image-set(url(data:a;b,{x}) 1x) }',
			'a { -webkit-content:"a;}b" }',
		]);
	});

	test('an escaped character in a selector does not open or close anything', () => {
		expect(prefixDifference('.w-\\(x{color:red}a{-webkit-x:1}', '').removed).toEqual([
			'a { -webkit-x:1 }',
		]);
		expect(prefixDifference('.a\\{b{-webkit-x:1}', '').removed).toEqual([
			'.a\\{b { -webkit-x:1 }',
		]);
	});

	test('comments are ignored and repeated declarations are counted', () => {
		expect(
			prefixDifference(
				'a{-webkit-x:1}/* b{-webkit-y:1} */a{-webkit-x:1}',
				'a{-webkit-x:1}',
			),
		).toEqual({ removed: ['a { -webkit-x:1 }'], added: [] });
	});

	test('a prefix in the property or in the value counts', () => {
		expect(
			prefixDifference('a{-ms-flex:1;display:-webkit-box;color:red}', 'a{color:blue}'),
		).toEqual({ removed: ['a { -ms-flex:1 }', 'a { display:-webkit-box }'], added: [] });
	});

	test('a prefixed selector or at-rule counts for every declaration inside it', () => {
		expect(
			prefixDifference(
				'@-webkit-keyframes s{to{opacity:0}}input::-moz-placeholder{color:#999}',
				'',
			),
		).toEqual({
			removed: [
				'@-webkit-keyframes s > to { opacity:0 }',
				'input::-moz-placeholder { color:#999 }',
			],
			added: [],
		});
	});

	test('whitespace that minifiers write differently does not make a difference', () => {
		expect(prefixDifference('a, b > c{-webkit-x : 1}', 'a,b>c{-webkit-x:1}')).toEqual({
			removed: [],
			added: [],
		});
	});

	test('a space before a colon in a selector is kept, as it means a descendant', () => {
		expect(prefixDifference('a :hover{-webkit-x:1}', 'a:hover{-webkit-x:1}')).toEqual({
			removed: ['a :hover { -webkit-x:1 }'],
			added: ['a:hover { -webkit-x:1 }'],
		});
	});

	test('a prefix is found without case', () => {
		expect(prefixDifference('a{-WEBKIT-x:1}', '').removed).toEqual(['a { -WEBKIT-x:1 }']);
	});

	test('a word that only contains a prefix-like part does not count', () => {
		expect(prefixDifference('a{font-family:x-ms-y}', '')).toEqual({
			removed: [],
			added: [],
		});
	});
});

describe('classAttributeSelectors', () => {
	test('selectors that test the class attribute are found in a selector list', () => {
		expect(
			classAttributeSelectors(
				'ul:not([class]),.a{margin:0}[class=""]{x:1}.b{x:1}@media print{p[class]{x:1}}',
			),
		).toEqual(['ul:not([class])', '[class=""]', 'p[class]']);
	});

	test('selectors that an empty value never matches do not count', () => {
		expect(
			classAttributeSelectors(
				'[class^=icon-]{x:1}[class*=" a"]{x:1}[class$=b]{x:1}[class~=c]{x:1}[class=d]{x:1}',
			),
		).toEqual([]);
	});

	test('an empty value test with a flag counts', () => {
		expect(classAttributeSelectors("[class|='' i]{x:1}")).toEqual(["[class|='' i]"]);
	});

	test('a comma inside :is() does not split the selector', () => {
		expect(classAttributeSelectors(':is(a,b)[class]{x:1}')).toEqual([':is(a,b)[class]']);
	});

	test('a nested rule is shown inside the rules that enclose it', () => {
		expect(
			classAttributeSelectors('[data-x=y]{margin:0;ul:not([class]){li{margin:0}}}'),
		).toEqual(['[data-x=y] { ul:not([class]) }']);
	});

	test('a child combinator with spaces stays part of the selector', () => {
		expect(classAttributeSelectors('.a > p:not([class]) {margin:0}')).toEqual([
			'.a > p:not([class])',
		]);
	});

	test('at-rules around a rule are not part of the selector', () => {
		expect(classAttributeSelectors('@layer x{@media print{p[class]{x:1}}}')).toEqual([
			'p[class]',
		]);
	});

	test('the attribute name is matched without case', () => {
		expect(classAttributeSelectors('ul:not([CLASS]){x:1}')).toEqual(['ul:not([CLASS])']);
	});

	test('other attribute selectors do not count', () => {
		expect(classAttributeSelectors('[data-class]{x:1}[classname]{x:1}')).toEqual([]);
	});
});
