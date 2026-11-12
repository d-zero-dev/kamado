import { describe, expect, test } from 'vitest';

import { cutLine, showControls, showControlsByLine } from './terminal.js';

/**
 * The character with a code point, so that no control character is written in this file.
 * @param code
 */
const ch = (code: number): string => String.fromCodePoint(code);
/**
 * How a code point above 255 is spelled: a backslash, `u`, and four upper-case hex digits.
 * @param code
 */
const spelledU = (code: number): string =>
	`\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
/**
 * How a code point up to 255 is spelled: a backslash, `x`, and two upper-case hex digits.
 * @param code
 */
const spelledX = (code: number): string =>
	`\\x${code.toString(16).toUpperCase().padStart(2, '0')}`;

describe('showControls', () => {
	test.each([
		['plain text stays', 'plain /a/b?c#d', 'plain /a/b?c#d'],
		[
			'the escape of an ANSI sequence is spelled out',
			`a${ch(27)}[2Jb`,
			`a${spelledX(27)}[2Jb`,
		],
		['a newline does not end the line', `one${ch(10)}two`, 'one\\ntwo'],
		['a carriage return does not rewind the line', `one${ch(13)}two`, 'one\\rtwo'],
		['a tab', `a${ch(9)}b`, 'a\\tb'],
		['a bell', `a${ch(7)}`, `a${spelledX(7)}`],
		['a delete', `a${ch(127)}`, `a${spelledX(127)}`],
		['a C1 control', `a${ch(155)}31m`, `a${spelledX(155)}31m`],
		['a right-to-left override', `abc${ch(8238)}def`, `abc${spelledU(8238)}def`],
		[
			'a bidirectional isolate',
			`a${ch(8294)}b${ch(8297)}`,
			`a${spelledU(8294)}b${spelledU(8297)}`,
		],
		['a zero-width space', `a${ch(8203)}b`, `a${spelledU(8203)}b`],
		['a line separator', `a${ch(8232)}b`, `a${spelledU(8232)}b`],
		['a byte order mark', `${ch(65_279)}a`, `${spelledU(65_279)}a`],
		['a soft hyphen', `a${ch(173)}b`, `a${spelledX(173)}b`],
		['a blank Braille pattern', `a${ch(10_240)}b`, `a${spelledU(10_240)}b`],
		[
			'a tag character, which spells text no one sees',
			`a${ch(917_505)}b`,
			`a\\u${(917_505).toString(16).toUpperCase()}b`,
		],
		['a variation selector', `a${ch(65_039)}b`, `a${spelledU(65_039)}b`],
		['text in other scripts stays', 'タイトル 😀 é', 'タイトル 😀 é'],
	])('%s', (_name, input, output) => {
		expect(showControls(input)).toBe(output);
	});

	test('what it gives has none of the characters it spells out', () => {
		const hostile = Array.from({ length: 8448 }, (_, i) => ch(i)).join('');
		const shown = showControls(hostile);
		for (const code of [0, 9, 10, 13, 27, 127, 155, 8203, 8234, 8238, 8294]) {
			expect(shown.includes(ch(code)), `U+${code.toString(16)}`).toBe(false);
		}
	});
});

describe('showControlsByLine', () => {
	test('keeps the lines and spells out what is in them', () => {
		const input = `Error: x${ch(10)}    at f (a.js:1)${ch(27)}[0m${ch(13)}${ch(10)}    at g`;
		expect(showControlsByLine(input)).toBe(
			`Error: x\n    at f (a.js:1)${spelledX(27)}[0m\n    at g`,
		);
	});
});

describe('cutLine', () => {
	test('leaves a short line', () => {
		expect(cutLine('abc', 3)).toBe('abc');
	});
	test('cuts a long line with an ellipsis', () => {
		expect(cutLine('abcdef', 4)).toBe('abc…');
	});
	test('counts characters, not code units', () => {
		expect(cutLine('😀😀😀😀', 3)).toBe('😀😀…');
	});
});
