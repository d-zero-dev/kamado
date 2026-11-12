/**
 * Makes text that came from outside (a script, a file, an error) safe to put on a terminal or
 * in a confirmation: its control characters are spelled out, so that it cannot move the cursor,
 * recolour or erase what was written before it, reorder what is shown, or end a line to fake
 * the next one (RFC §14.2, "同期").
 *
 * The characters are told by their code points, not by a pattern written with them: a pattern
 * with a line separator in it does not even parse as source.
 */

/**
 * The ranges spelled out, as `[first, last]` code points: C0 controls (a newline, a tab and
 * the escape of an ANSI sequence are among them), delete and the C1 controls, the Arabic letter
 * mark, the zero-width and direction marks, the line and paragraph separators and the
 * bidirectional embeddings and overrides, the word joiner to the bidirectional isolates, and
 * the byte order mark. As code points: U+0000-U+001F, U+007F-U+009F, U+061C, U+200B-U+200F,
 * U+2028-U+202E, U+2060-U+2069 and U+FEFF (written in decimal below).
 */
const RANGES: readonly (readonly [number, number])[] = [
	[0, 31],
	[127, 159],
	[1564, 1564],
	[8203, 8207],
	[8232, 8238],
	[8288, 8297],
	[65_279, 65_279],
	// characters that show nothing, or change how what is near them shows (a soft hyphen, a
	// grapheme joiner, the Mongolian vowel separator, a blank Braille pattern, the interlinear
	// annotation marks, the variation selectors, and the tag characters that spell text no one sees)
	[173, 173],
	[847, 847],
	[6158, 6158],
	[10_240, 10_240],
	[65_529, 65_531],
	[65_024, 65_039],
	[917_504, 917_631],
	[917_760, 917_999],
];

const NAMED: ReadonlyMap<number, string> = new Map([
	[10, String.raw`\n`],
	[13, String.raw`\r`],
	[9, String.raw`\t`],
]);

/**
 * Whether a code point is spelled out.
 * @param code - A code point
 */
function isSpelled(code: number): boolean {
	return RANGES.some(([first, last]) => code >= first && code <= last);
}

/**
 * Spells out every control character, a newline too: for text that is one line (a URL, a path, a
 * key, a value, a message).
 * @param text - Any text
 * @returns The text with the controls written as `\n`, `\x1B`, `\u202E` and so on
 * @example
 * ```ts
 * showControls('line\nline'); // 'line\\nline'
 * showControls(`a${String.fromCodePoint(27)}[2Jb`); // 'a\\x1B[2Jb'
 * ```
 */
export function showControls(text: string): string {
	let out = '';
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if (!isSpelled(code)) {
			out += char;
			continue;
		}
		const named = NAMED.get(code);
		if (named !== undefined) {
			out += named;
		} else if (code <= 255) {
			out += `\\x${code.toString(16).toUpperCase().padStart(2, '0')}`;
		} else {
			out += `\\u${code.toString(16).toUpperCase().padStart(4, '0')}`;
		}
	}
	return out;
}

/**
 * Spells out the control characters of each line and keeps the lines: for a stack trace.
 * @param text - Text of several lines
 * @returns The same lines, each with its controls spelled out
 * @example
 * ```ts
 * showControlsByLine('Error: x\n    at f'); // 'Error: x\n    at f'
 * ```
 */
export function showControlsByLine(text: string): string {
	return text
		.split(/\r\n|\n|\r/u)
		.map(showControls)
		.join('\n');
}

/**
 * Cuts a line to `max` characters, with an ellipsis, so that one line of a log cannot be as
 * long as it likes.
 * @param text - A line
 * @param max - The most characters kept
 * @returns The line, or its first `max - 1` characters and `…`
 * @example
 * ```ts
 * cutLine('abcdef', 4); // 'abc…'
 * ```
 */
export function cutLine(text: string, max: number): string {
	const chars = [...text];
	return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}
