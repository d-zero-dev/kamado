/**
 * Text transforms that `check-css.mjs` applies to minified style sheets before
 * it compares two spellings of the same one (see `benign` there).
 */

/**
 * The start of a block that may be joined with, or dropped as a repeat of, a
 * neighbour with the same header: `@media`, `@supports`, `@container` and a
 * named `@layer` (an anonymous one is a layer of its own each time).
 */
const groupAtRuleStart = /@(?:media|supports|container|layer\s+[^\s{};])[^{};]*\{/gu;

/**
 * Finds the end of a block, skipping strings, comments and escapes, so that a
 * brace inside `content:"}"` does not end it.
 * @param {string} css - A style sheet
 * @param {number} from - The index just after the block's opening brace
 * @returns {number} The index just after the closing brace, or -1 when it has none
 * @example
 * blockEnd('a{b:c}d', 2); // 6
 * blockEnd('a{content:"}"}x', 2); // 14
 */
export function blockEnd(css, from) {
	let depth = 1;
	let i = from;
	while (i < css.length) {
		const c = css[i];
		if (c === '\\') {
			i += 2;
		} else if (c === '"' || c === "'") {
			i++;
			while (i < css.length && css[i] !== c) {
				i += css[i] === '\\' ? 2 : 1;
			}
			i++;
		} else if (c === '/' && css[i + 1] === '*') {
			const close = css.indexOf('*/', i + 2);
			i = close === -1 ? css.length : close + 2;
		} else {
			if (c === '{') {
				depth++;
			} else if (c === '}' && --depth === 0) {
				return i + 1;
			}
			i++;
		}
	}
	return -1;
}

/**
 * Joins neighbouring `@media` / `@supports` / `@container` / named `@layer`
 * blocks that have the same query or name, so that two spellings of the same
 * style sheet compare equal. (An anonymous `@layer` is a layer of its own each
 * time.)
 * @param {string} css - A minified style sheet
 * @returns {string} The style sheet with the blocks joined
 * @example
 * joinAdjacentAtRules('@media x{a{b:c}}@media x{d{e:f}}'); // '@media x{a{b:c}d{e:f}}'
 */
export function joinAdjacentAtRules(css) {
	let out = css;
	const start = new RegExp(groupAtRuleStart);
	let match = start.exec(out);
	while (match) {
		const header = match[0];
		const end = blockEnd(out, match.index + header.length);
		if (end !== -1 && out.startsWith(header, end)) {
			out = out.slice(0, end - 1) + out.slice(end + header.length);
			start.lastIndex = match.index;
		}
		match = start.exec(out);
	}
	return out;
}

/**
 * Drops a block that repeats the block before it, byte for byte, for the
 * blocks whose repetition adds nothing: `@media`, `@supports`, `@container` and
 * a named `@layer`. (An anonymous `@layer` is a layer of its own each time.)
 * @param {string} css - A minified style sheet
 * @returns {string} The style sheet without the repeats
 * @example
 * dropRepeatedAtRules('@media x{a{b:c}}@media x{a{b:c}}'); // '@media x{a{b:c}}'
 */
export function dropRepeatedAtRules(css) {
	let out = css;
	const start = new RegExp(groupAtRuleStart);
	let match = start.exec(out);
	while (match) {
		const end = blockEnd(out, match.index + match[0].length);
		if (end !== -1) {
			const block = out.slice(match.index, end);
			if (out.startsWith(block, end)) {
				out = out.slice(0, end) + out.slice(end + block.length);
				start.lastIndex = match.index;
			}
		}
		match = start.exec(out);
	}
	return out;
}
