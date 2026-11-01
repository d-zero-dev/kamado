/**
 * Normalizes an HTML document so that two outputs that render the same compare equal
 * (the `--semantic` mode of the parity harness, used to check a migration from v2).
 *
 * What is made equal:
 * - the order of attributes, their quotes, the case of tag and attribute names, an
 *   empty value and no value (`disabled=""` and `disabled`), runs of whitespace inside
 *   a `class` value, the case of the doctype
 * - character references (`&nbsp;` and `&#160;`, `&amp;` and `&`), decoded per token
 *   so that an escaped `&lt;b&gt;` never turns into a tag. Numeric references follow
 *   the parser (`&#150;` is the Windows-1252 dash; out of range is U+FFFD). A named
 *   reference needs its semicolon here; without one it stays as written
 * - whitespace that is not rendered. Runs collapse to one space. A space next to a
 *   block boundary is dropped, and so is a space right after another one; both are
 *   judged by looking past comments, elements that are not rendered (`script`,
 *   `style`, `meta`, `link`, `base`, `template`) and the tags of inline elements. The
 *   search stops at replaced and void elements (`img`, `br`, `svg`) and at the outside
 *   of inline blocks (`button`, `select`, `textarea`), whose inside edges are block
 *   boundaries. Whitespace between the elements of the `head` and around the text of
 *   the `title` is dropped. `pre`, `listing`, `plaintext` and `textarea` keep theirs,
 *   less the one literal newline the parser drops after their start tag
 * - the self-closing slash, which HTML ignores (inside `svg` and `math` it closes)
 * - optional tags of the head: a `head` ends where the parser ends it (at the first
 *   element or text that cannot be in it), whether `</head>` is written or not
 *
 * What is taken out and returned on the side, for the caller to compare:
 * - the contents of `script` and `style` and the values of `style` attributes
 *   (minifiers write them differently); the markup keeps where they were
 * - which elements have an empty `class` attribute: `class=""` matches `[class]` and
 *   `:not([class])` in CSS, so it is not the same as no attribute
 *
 * Limits: whitespace is judged by the default `display` and `white-space` of the
 * elements, without reading the CSS. Where CSS changes them (a `div` made inline, a
 * `white-space: pre`), two outputs that render the same can compare different, and a
 * difference in boundary whitespace can compare equal. Some renderings that are the
 * same still compare different: a trailing space inside an inline element whose next
 * text starts with a space, other optional tags (`</p>`, `<body>`, `<tbody>`), and the
 * contents of `noscript`, which are read as markup. Comments, processing instructions
 * (`<?php ?>`) and the contents of `xmp`, `iframe`, `noembed` and `noframes` are
 * compared as written.
 */
import { characterEntities } from 'character-entities';

/**
 * A normalized page: the markup to compare and what was set aside from it.
 * @example
 * const { markup, inline, emptyClass }: NormalizedHtml = normalizeHtml('<p class="">x</p>');
 * // markup: '<p>\nx\n</p>', inline: { scripts: [], styles: [] }, emptyClass: [0]
 */
export type NormalizedHtml = {
	/** One token per line, for comparing and for a line diff. */
	readonly markup: string;
	readonly inline: {
		readonly scripts: readonly string[];
		readonly styles: readonly string[];
	};
	/**
	 * The start tags, counted from 0 in document order, that have an empty `class`
	 * attribute. Two pages with the same markup have the same start tags, so equal
	 * lists mean the same elements.
	 */
	readonly emptyClass: readonly number[];
};

type Token =
	| { readonly type: 'start'; readonly name: string; readonly attrs: readonly string[] }
	| { readonly type: 'end'; readonly name: string }
	| { readonly type: 'text'; text: string }
	| { readonly type: 'raw'; readonly text: string; readonly comment: boolean };

const words = (...lines: string[]) => new Set(lines.join(' ').split(' '));

const VOID = words('area base br col embed hr img input link meta source track wbr');

// Elements whose default `display` is a block, a table part or a list item, from the
// rendering section of the HTML standard. `head` is here because nothing in it is
// rendered.
const BLOCK = words(
	'address article aside blockquote body center dd details dialog dir div dl dt',
	'fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hgroup hr html',
	'legend li listing main menu nav ol optgroup option p plaintext pre search section',
	'summary ul xmp table caption colgroup col thead tbody tfoot tr td th head',
);
// Not rendered: whitespace on both sides of them is judged as if they were not there.
const HIDDEN = words('script style meta link base template');
// Inline blocks: a boundary on the inside, a box on the outside. `label` is inline.
const INLINE_BLOCK = words('button select textarea');
// Inline content that whitespace does not collapse across.
const ATOMIC = words(
	'area br embed hr img input source track wbr svg math iframe video audio canvas object',
);
const PRESERVE = words('pre listing textarea plaintext');
const RAW_TEXT = words('script style');
const ESCAPABLE_RAW_TEXT = words('textarea title');
const VERBATIM = words('xmp iframe noembed noframes');
const FOREIGN = words('svg math');
const HEAD_CONTENT = words(
	'base basefont bgsound link meta noframes noscript script style template title',
);

// The parser maps these numeric references to the Windows-1252 characters.
const WINDOWS_1252: Readonly<Record<number, number>> = {
	0x80: 0x20_ac,
	0x82: 0x20_1a,
	0x83: 0x01_92,
	0x84: 0x20_1e,
	0x85: 0x20_26,
	0x86: 0x20_20,
	0x87: 0x20_21,
	0x88: 0x02_c6,
	0x89: 0x20_30,
	0x8a: 0x01_60,
	0x8b: 0x20_39,
	0x8c: 0x01_52,
	0x8e: 0x01_7d,
	0x91: 0x20_18,
	0x92: 0x20_19,
	0x93: 0x20_1c,
	0x94: 0x20_1d,
	0x95: 0x20_22,
	0x96: 0x20_13,
	0x97: 0x20_14,
	0x98: 0x02_dc,
	0x99: 0x21_22,
	0x9a: 0x01_61,
	0x9b: 0x20_3a,
	0x9c: 0x01_53,
	0x9e: 0x01_7e,
	0x9f: 0x01_78,
};

const REFERENCE = /&(?:#(\d+)|#x([\da-f]+)|([A-Z][A-Z\d]*));?/gi;

const decode = (text: string) =>
	text.replaceAll(
		REFERENCE,
		(
			whole,
			dec: string | undefined,
			hex: string | undefined,
			name: string | undefined,
		) => {
			if (dec !== undefined || hex !== undefined) {
				const code = dec === undefined ? Number.parseInt(hex!, 16) : Number(dec);
				if (code === 0 || code > 0x10_ff_ff || (code >= 0xd8_00 && code <= 0xdf_ff)) {
					return '�';
				}
				return String.fromCodePoint(WINDOWS_1252[code] ?? code);
			}
			if (!whole.endsWith(';') || !Object.hasOwn(characterEntities, name!)) {
				return whole;
			}
			return characterEntities[name!]!;
		},
	);

const escapeText = (text: string) =>
	text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll(' ', '&nbsp;');

const escapeAttr = (value: string) =>
	value
		.replaceAll('&', '&amp;')
		.replaceAll('"', '&quot;')
		.replaceAll('>', '&gt;')
		.replaceAll(' ', '&nbsp;');

const isSpace = (ch: string | undefined) =>
	ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';

const isLetter = (ch: string | undefined) => ch !== undefined && /[A-Z]/i.test(ch);

/**
 * Normalizes one HTML document.
 * @param source - The document as text
 * @example
 * normalizeHtml('<P class=a>x&nbsp;y</P>').markup === normalizeHtml('<p class="a">x&#160;y</p>').markup;
 */
export function normalizeHtml(source: string): NormalizedHtml {
	// The parser reads CR LF and a lone CR as LF before anything else.
	const html = source.replaceAll(/\r\n?/g, '\n');
	const tokens: Token[] = [];
	const scripts: string[] = [];
	const styles: string[] = [];
	const emptyClass: number[] = [];
	const open: string[] = [];
	let ordinal = 0;
	// Set after the start tag of `pre` / `listing`: the parser drops one literal newline.
	let dropNewline = false;
	let i = 0;

	const inForeign = () => open.some((n) => FOREIGN.has(n));
	const closeTo = (name: string) => {
		const at = open.lastIndexOf(name);
		if (at !== -1) {
			open.length = at;
		}
	};
	// The parser ends the head at the first element or text that cannot be in it.
	const leaveHead = () => {
		if (open.at(-1) === 'head') {
			open.pop();
			tokens.push({ type: 'end', name: 'head' });
		}
	};
	const pushText = (text: string) => {
		if (text === '') {
			return;
		}
		if (/[^\t\n\f\r ]/.test(text)) {
			leaveHead();
		}
		const last = tokens.at(-1);
		if (last?.type === 'text') {
			last.text += text;
		} else {
			tokens.push({ type: 'text', text });
		}
	};
	const pushRaw = (text: string, comment = false) => {
		tokens.push({ type: 'raw', text, comment });
	};

	while (i < html.length) {
		const ch = html[i];
		const next = html[i + 1];
		const newline = dropNewline;
		dropNewline = false;
		if (ch !== '<') {
			const end = html.indexOf('<', i + 1);
			const stop = end === -1 ? html.length : end;
			let text = html.slice(i, stop);
			if (newline) {
				text = text.replace(/^\n/, '');
			}
			pushText(decode(text));
			i = stop;
			continue;
		}
		if (html.startsWith('<!--', i)) {
			// `<!-->` and `<!--->` are complete, empty comments.
			const empty = /^<!---?>/.exec(html.slice(i, i + 6));
			const end = empty ? i + empty[0].length - 3 : html.indexOf('-->', i + 4);
			const stop = end === -1 ? html.length : end + 3;
			pushRaw(html.slice(i, stop), true);
			i = stop;
			continue;
		}
		if (html.startsWith('<![CDATA[', i) && inForeign()) {
			const end = html.indexOf(']]>', i + 9);
			const stop = end === -1 ? html.length : end + 3;
			pushRaw(html.slice(i, stop));
			i = stop;
			continue;
		}
		if (next === '!' || next === '?') {
			// A processing instruction (`<?php ... ?>`) can hold `>`, so it ends at `?>`.
			const end = next === '?' ? html.indexOf('?>', i + 2) : -1;
			const close = html.indexOf('>', i + 2);
			const stop = end === -1 ? (close === -1 ? html.length : close + 1) : end + 2;
			let text = html.slice(i, stop);
			if (/^<!doctype/i.test(text)) {
				text = text.replaceAll(/\s+/g, ' ').replace(/ >$/, '>').toLowerCase();
				pushRaw(text);
			} else {
				pushRaw(text, true);
			}
			i = stop;
			continue;
		}
		if (next === '/' && isLetter(html[i + 2])) {
			let j = i + 2;
			while (j < html.length && !isSpace(html[j]) && html[j] !== '/' && html[j] !== '>') {
				j++;
			}
			const name = html.slice(i + 2, j).toLowerCase();
			const end = html.indexOf('>', j);
			i = end === -1 ? html.length : end + 1;
			// A `</head>` after the parser ended the head does nothing.
			if (name === 'head' && !open.includes('head')) {
				continue;
			}
			closeTo(name);
			tokens.push({ type: 'end', name });
			continue;
		}
		if (!isLetter(next)) {
			pushText(ch);
			i++;
			continue;
		}

		// A start tag.
		let j = i + 1;
		while (j < html.length && !isSpace(html[j]) && html[j] !== '/' && html[j] !== '>') {
			j++;
		}
		const name = html.slice(i + 1, j).toLowerCase();
		const attrs = new Map<string, string>();
		let selfClosing = false;
		while (j < html.length) {
			while (isSpace(html[j]) || html[j] === '/') {
				selfClosing = html[j] === '/';
				j++;
			}
			if (j >= html.length || html[j] === '>') {
				break;
			}
			selfClosing = false;
			const nameStart = j;
			j++;
			while (
				j < html.length &&
				!isSpace(html[j]) &&
				html[j] !== '/' &&
				html[j] !== '>' &&
				html[j] !== '='
			) {
				j++;
			}
			const attrName = html.slice(nameStart, j).toLowerCase();
			let k = j;
			while (isSpace(html[k])) {
				k++;
			}
			let value = '';
			if (html[k] === '=') {
				k++;
				while (isSpace(html[k])) {
					k++;
				}
				const quote = html[k];
				if (quote === '"' || quote === "'") {
					const close = html.indexOf(quote, k + 1);
					const stop = close === -1 ? html.length : close;
					value = html.slice(k + 1, stop);
					k = stop + 1;
				} else {
					const start = k;
					while (k < html.length && !isSpace(html[k]) && html[k] !== '>') {
						k++;
					}
					value = html.slice(start, k);
				}
				j = k;
			}
			// The first of two attributes with the same name wins, as in the parser.
			if (!attrs.has(attrName)) {
				attrs.set(attrName, decode(value));
			}
		}
		i = j < html.length ? j + 1 : html.length;

		const foreign = inForeign();
		if (open.at(-1) === 'head' && !foreign && !HEAD_CONTENT.has(name)) {
			leaveHead();
		}
		const written: string[] = [];
		for (const [attrName, value] of [...attrs].toSorted(([a], [b]) => (a < b ? -1 : 1))) {
			if (attrName === 'class') {
				const classes = value
					.split(/[\t\n\f\r ]+/)
					.filter(Boolean)
					.join(' ');
				if (value === '') {
					emptyClass.push(ordinal);
					continue;
				}
				// Only whitespace has no classes, yet unlike `class=""` it does not match
				// `[class=""]`, so it stays in the markup.
				written.push(`class="${classes === '' ? ' ' : escapeAttr(classes)}"`);
			} else if (attrName === 'style') {
				styles.push(value);
				written.push('style');
			} else {
				written.push(value === '' ? attrName : `${attrName}="${escapeAttr(value)}"`);
			}
		}
		ordinal++;
		tokens.push({ type: 'start', name, attrs: written });

		if (VOID.has(name) && !foreign) {
			continue;
		}
		if (selfClosing && (foreign || FOREIGN.has(name))) {
			tokens.push({ type: 'end', name });
			continue;
		}
		const raw =
			!foreign &&
			(RAW_TEXT.has(name) || ESCAPABLE_RAW_TEXT.has(name) || VERBATIM.has(name));
		if (raw) {
			const close = new RegExp(`</${name}[\\t\\n\\f\\r />]`, 'i');
			const rest = html.slice(i);
			const found = close.exec(rest);
			const content = found ? rest.slice(0, found.index) : rest;
			if (name === 'script') {
				scripts.push(content);
			} else if (name === 'style') {
				styles.push(content);
			} else if (VERBATIM.has(name)) {
				if (content !== '') {
					pushRaw(content);
				}
			} else {
				// `textarea` and `title`: text with references, read up to the end tag.
				const text = name === 'textarea' ? content.replace(/^\n/, '') : content;
				if (text !== '') {
					tokens.push({ type: 'text', text: decode(text) });
				}
			}
			i += content.length;
			if (found) {
				const end = html.indexOf('>', i);
				i = end === -1 ? html.length : end + 1;
			}
			tokens.push({ type: 'end', name });
			continue;
		}
		open.push(name);
		dropNewline = !foreign && (name === 'pre' || name === 'listing');
	}

	return { markup: serialize(tokens), inline: { scripts, styles }, emptyClass };
}

type Stop = 'boundary' | 'space' | 'none';

// Turns the tokens into lines, dropping the whitespace that is not rendered.
/**
 *
 * @param tokens
 */
function serialize(tokens: readonly Token[]): string {
	const out: (string | null)[] = Array.from({ length: tokens.length }, () => null);

	// Whether a token is passed over when looking for what is next to a space.
	const passOver = (token: Token) =>
		(token.type === 'raw' && token.comment) ||
		((token.type === 'start' || token.type === 'end') &&
			(HIDDEN.has(token.name) ||
				(!BLOCK.has(token.name) &&
					!INLINE_BLOCK.has(token.name) &&
					!ATOMIC.has(token.name))));

	// What comes before a space at `index`: a block boundary, a space already written,
	// or something else (text, a replaced element, the outside of an inline block).
	const before = (index: number): Stop => {
		for (let k = index - 1; k >= 0; k--) {
			const token = tokens[k]!;
			if (passOver(token)) {
				continue;
			}
			if (token.type === 'text') {
				// A text that was dropped entirely is not there either.
				if (out[k] === '') {
					continue;
				}
				return out[k]!.endsWith(' ') ? 'space' : 'none';
			}
			if (token.type === 'start' || token.type === 'end') {
				if (BLOCK.has(token.name)) {
					return 'boundary';
				}
				if (INLINE_BLOCK.has(token.name) && token.type === 'start') {
					return 'boundary';
				}
			}
			return 'none';
		}
		return 'boundary';
	};
	const after = (index: number): Stop => {
		for (let k = index + 1; k < tokens.length; k++) {
			const token = tokens[k]!;
			// A following text of only whitespace collapses into this space.
			if (
				passOver(token) ||
				(token.type === 'text' && !/[^\t\n\f\r ]/.test(token.text))
			) {
				continue;
			}
			if (token.type === 'start' || token.type === 'end') {
				if (BLOCK.has(token.name)) {
					return 'boundary';
				}
				if (INLINE_BLOCK.has(token.name) && token.type === 'end') {
					return 'boundary';
				}
			}
			return 'none';
		}
		return 'boundary';
	};

	const open: string[] = [];
	for (const [index, token] of tokens.entries()) {
		switch (token.type) {
			case 'start': {
				out[index] = `<${token.name}${token.attrs.map((a) => ` ${a}`).join('')}>`;
				if (!VOID.has(token.name)) {
					open.push(token.name);
				}
				break;
			}
			case 'end': {
				const at = open.lastIndexOf(token.name);
				if (at !== -1) {
					open.length = at;
				}
				out[index] = `</${token.name}>`;
				break;
			}
			case 'raw': {
				out[index] = token.text;
				break;
			}
			case 'text': {
				if (open.some((n) => PRESERVE.has(n))) {
					out[index] = escapeText(token.text);
					break;
				}
				let text = token.text.replaceAll(/[\t\n\f\r ]+/g, ' ');
				if (open.at(-1) === 'title') {
					// The title is shown with its whitespace stripped and collapsed.
					text = text.trim();
				} else if (text === ' ' && open.includes('head')) {
					// Nothing in the head is rendered.
					text = '';
				}
				if (text.startsWith(' ') && before(index) !== 'none') {
					text = text.slice(1);
				}
				if (text.endsWith(' ') && after(index) === 'boundary') {
					text = text.slice(0, -1);
				}
				out[index] = escapeText(text);
				break;
			}
		}
	}
	return out.filter((line) => line !== null && line !== '').join('\n');
}
