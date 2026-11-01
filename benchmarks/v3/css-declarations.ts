/**
 * Declaration-level views of a stylesheet, for the `--semantic` mode of the parity
 * harness. They read the text without a CSS parser: strings and parentheses are
 * skipped over, so `;`, `{` and `}` inside `url(...)`, `"..."` or `:not(...)` do not
 * split anything.
 */

type Entry = {
	/** The preludes of the enclosing blocks, outermost first (selectors and at-rules). */
	readonly blocks: readonly string[];
	readonly declaration: string;
};

// Walks the declarations of a stylesheet with the blocks that enclose each one.
/**
 *
 * @param css
 */
function entries(css: string): Entry[] {
	const out: Entry[] = [];
	const stack: string[] = [];
	let buf = '';
	let quote: string | null = null;
	let depth = 0;
	const push = (text: string) => {
		const declaration = text.trim();
		if (declaration !== '') {
			out.push({ blocks: [...stack], declaration });
		}
	};
	const source = css.replaceAll(/\/\*[\s\S]*?\*\//g, '');
	for (let i = 0; i < source.length; i++) {
		const ch = source[i]!;
		if (quote) {
			buf += ch;
			if (ch === '\\') {
				buf += source[++i] ?? '';
			} else if (ch === quote) {
				quote = null;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			buf += ch;
			continue;
		}
		// An escaped character (`.w-\(x`, `.a\{b`) is part of a name, never syntax.
		if (ch === '\\') {
			buf += ch + (source[++i] ?? '');
			continue;
		}
		if (ch === '(') {
			depth++;
		} else if (ch === ')') {
			depth = Math.max(0, depth - 1);
		}
		if (depth > 0) {
			buf += ch;
			continue;
		}
		switch (ch) {
			case '{': {
				stack.push(buf.trim());
				buf = '';

				break;
			}
			case '}': {
				push(buf);
				buf = '';
				stack.pop();

				break;
			}
			case ';': {
				push(buf);
				buf = '';

				break;
			}
			default: {
				buf += ch;
			}
		}
	}
	push(buf);
	return out;
}

const PREFIXED = /(?:^|[\s,(:@>+~])-(?:webkit|moz|ms|o)-/i;

// Whitespace that minifiers write differently: runs, and around `,` `>` `+` `~` in a
// prelude (a space before `:` is a descendant combinator, so it is kept).
const tidyPrelude = (prelude: string) =>
	prelude
		.replaceAll(/\s+/g, ' ')
		.replaceAll(/ ?([,>+~]) ?/g, '$1')
		.trim();
// Runs of whitespace, and around the colon after the property.
const tidyDeclaration = (declaration: string) =>
	declaration
		.replaceAll(/\s+/g, ' ')
		.replace(/^([^:]*?) ?: ?/, '$1:')
		.trim();

/**
 * The declarations with a vendor prefix that only one of two stylesheets has. The
 * prefix can be in the property or the value, or in a selector or at-rule around the
 * declaration (`::-moz-placeholder`, `@-webkit-keyframes`): autoprefixer writes those
 * as rules of their own. Whitespace is tidied first (`a, b{-webkit-x: 1}` and
 * `a,b{-webkit-x:1}` are the same). A prefixed declaration whose value is otherwise
 * written differently (`#fff` and `#ffffff`) shows up on both sides.
 * @param baseline - The reference stylesheet (v2)
 * @param candidate - The stylesheet under test (v3)
 * @example
 * prefixDifference('a{-webkit-x:1;x:1}', 'a{x:1}'); // { removed: ['a { -webkit-x:1 }'], added: [] }
 */
export function prefixDifference(
	baseline: string,
	candidate: string,
): { removed: string[]; added: string[] } {
	const count = (css: string) => {
		const out = new Map<string, number>();
		for (const { blocks, declaration } of entries(css)) {
			if (
				PREFIXED.test(declaration) ||
				blocks.some((prelude) => PREFIXED.test(prelude))
			) {
				const key = `${blocks.map(tidyPrelude).join(' > ')} { ${tidyDeclaration(declaration)} }`;
				out.set(key, (out.get(key) ?? 0) + 1);
			}
		}
		return out;
	};
	const a = count(baseline);
	const b = count(candidate);
	const only = (x: Map<string, number>, y: Map<string, number>) => {
		const keys: string[] = [];
		for (const [key, n] of x) {
			for (let i = y.get(key) ?? 0; i < n; i++) {
				keys.push(key);
			}
		}
		return keys;
	};
	return { removed: only(a, b), added: only(b, a) };
}

// `[class]`, and `[class=""]` / `[class|=""]` (with an optional `i` / `s` flag): the
// attribute selectors that an empty value matches. `[class^=x]`, `*=`, `$=` and `~=`
// never match an empty value, and `[class=x]` matches neither an empty value nor a
// missing attribute, so an empty class appearing or disappearing does not change them.
// Attribute names in selectors match HTML attributes without case.
const CLASS_ATTRIBUTE = /\[\s*class\s*(?:\|?=\s*(?:""|'')\s*(?:[is]\s*)?)?\]/i;

/**
 * The selectors whose match changes when an element gains or loses an empty
 * `class=""`: `[class]`, `:not([class])`, `[class=""]`. A nested rule is shown inside
 * the rules that enclose it (`.a { p:not([class]) }`).
 * @param css - The stylesheet as text
 * @example
 * classAttributeSelectors('ul:not([class]){margin:0}.a{color:red}'); // ['ul:not([class])']
 */
export function classAttributeSelectors(css: string): string[] {
	const found = new Set<string>();
	for (const { blocks } of entries(css)) {
		const rules = blocks.filter((prelude) => !prelude.startsWith('@'));
		for (const [index, rule] of rules.entries()) {
			for (const selector of splitSelectors(rule)) {
				if (!CLASS_ATTRIBUTE.test(selector)) {
					continue;
				}
				const outer = rules.slice(0, index);
				found.add(
					outer.map((r) => `${r} { `).join('') + selector + ' }'.repeat(outer.length),
				);
			}
		}
	}
	return [...found];
}

// Splits a selector list on the commas that are not inside parentheses or brackets.
/**
 *
 * @param list
 */
function splitSelectors(list: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < list.length; i++) {
		const ch = list[i];
		if (ch === '(' || ch === '[') {
			depth++;
		} else if (ch === ')' || ch === ']') {
			depth--;
		} else if (ch === ',' && depth === 0) {
			out.push(list.slice(start, i).trim());
			start = i + 1;
		}
	}
	out.push(list.slice(start).trim());
	return out.filter(Boolean);
}
