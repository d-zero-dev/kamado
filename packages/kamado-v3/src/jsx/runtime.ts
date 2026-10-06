/**
 * The JavaScript runtime that kamado v3's compiled JSX modules import.
 *
 * The Rust JSX compiler turns a TSX page into plain JavaScript that builds
 * HTML by string concatenation and calls the few functions exported here for
 * everything it cannot flatten. The output of this runtime equals what React
 * 19's `renderToStaticMarkup` produces (read from react-dom's
 * `react-dom-server-legacy.node.production.js`), byte for byte, with the
 * exceptions listed under "Deliberate deviations" below. The differential
 * suite in `runtime.spec.ts` renders the same trees with both and compares.
 *
 * ## How hoisting works without a tree
 *
 * React 19 moves `<title>`, `<meta>`, `<link>`, `<script async src>` and
 * `<style precedence href>` out of the tree into the document preamble. The
 * compiled code evaluates children before their parent, so a component that
 * ignores its `children`, or a layout whose own `<title>` comes first in the
 * output but is evaluated last, would be mis-ordered if hoistables were
 * recorded at evaluation time. Instead `el()` returns a position marker
 * (a NUL, a per-process random token and an id) for each hoistable inside the
 * render and keeps the chunk in the render context; `render()` scans the final
 * string once, in document order, resolves every marker that actually survived
 * into the output (a dropped child is never hoisted, exactly as in React), and
 * assembles the preamble in React's category order. `<head>` children are
 * fenced with markers for the same reason. Outside `render()` (plain `el()` /
 * `k()` calls) there is no context and hoistables are rendered in place.
 *
 * ## Contract for the compiler
 *
 * - Elements whose rendering depends on context must go through `el()`:
 * `html head body title meta link script style base noscript select option
 * optgroup textarea input form button img object a pre listing` and custom
 * elements. `img` matters because React preloads every non-lazy image into
 * the head; a constant `m("<img ...>")` cannot register that, use
 * `preloadImage()` next to it or `el("img", ...)`.
 * - Parents whose children's rendering depends on the parent (`select`, `svg`,
 * `foreignObject`, `noscript`, `picture`) take their children as a thunk
 * `() => children`, which `el()` calls with the parent's context installed.
 * - `title`, `textarea`, `option`, `script` and `style` want plain string or
 * number children, as React does. A `Markup` child is taken as already escaped
 * text (title/textarea/option), as style text (style) and ignored (script).
 *
 * ## Deliberate deviations from React
 *
 * - Function-valued `action` / `formAction` (server actions) are omitted;
 * React writes a `javascript:throw ...` URL and injects a replay script.
 * - `<head>`, `<body>` and `<html>` are always treated as the document's
 * singletons while a render is active; React renders them as ordinary elements
 * when nested inside another element (insertion mode), which a bottom-up
 * evaluation cannot see.
 * - A function passed as the `children` argument of `el()` is a thunk and is
 * called; React renders nothing for a function child.
 * - `Markup` children of `title` / `textarea` / `option` are not escaped again
 * (React would print `[object Object]` for an element child there).
 * - Left out: Suspense, context, hooks, class components, portals, refs, `use`,
 * lazy, memo, forwardRef, thenable children, React element children and
 * `defaultProps`.
 * @module
 */
/* eslint-disable unicorn/prefer-code-point -- hot paths compare single ASCII UTF-16 code units; `charCodeAt` is the cheapest and equivalent there */
import { randomUUID } from 'node:crypto';

import {
	BOOLEAN,
	BOOLEANISH_STRING,
	NUMERIC,
	OVERLOADED_BOOLEAN,
	POSITIVE_NUMERIC,
	PROPS,
	RESERVED,
	STRING,
	STYLE,
	UNITLESS,
	URL_ATTR,
	URL_ATTR_KEEP_EMPTY,
	VOID_ELEMENTS,
} from './attr-table.js';

type Props = Record<string, unknown>;

/**
 * An HTML string that is already escaped.
 * @example
 * ```ts
 * c(new Markup('<b>x</b>')); // '<b>x</b>'
 * ```
 */
export class Markup {
	/** The escaped HTML. */
	readonly html: string;

	/**
	 * @param html - Already-escaped HTML
	 */
	constructor(html: string) {
		this.html = html;
	}

	/**
	 * @returns The HTML
	 */
	toString(): string {
		return this.html;
	}
}

const EMPTY = new Markup('');
const EMPTY_PROPS: Props = {};

/**
 * Marks an already-escaped HTML string.
 * @param html - Escaped HTML
 * @returns The wrapper (not copied again by {@link c})
 * @example
 * ```ts
 * m('<p class="x">y</p>').html; // '<p class="x">y</p>'
 * ```
 */
export function m(html: string): Markup {
	return new Markup(html);
}

/**
 * Raw HTML as a child, next to other children (`dangerouslySetInnerHTML` is
 * for an element with no other children). The text is output as it is: it
 * must be HTML you trust and have escaped.
 * @param text - HTML
 * @returns A child that is not escaped
 * @example
 * ```tsx
 * import { html } from 'kamado-v3/jsx';
 *
 * const Body = ({ content }) => <div>{html(content)}<footer>end</footer></div>;
 * ```
 */
export function html(text: string): Markup {
	return new Markup(text);
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Escapes `& < > " '` like React's `escapeTextForBrowser`; returns the same
 * string when nothing needs escaping.
 * @param text - Raw text
 * @returns Escaped text
 */
function escapeText(text: string): string {
	const length = text.length;
	let out = '';
	let last = 0;
	for (let i = 0; i < length; i++) {
		let replacement: string;
		switch (text.charCodeAt(i)) {
			case 34: {
				replacement = '&quot;';
				break;
			}
			case 38: {
				replacement = '&amp;';
				break;
			}
			case 39: {
				replacement = '&#x27;';
				break;
			}
			case 60: {
				replacement = '&lt;';
				break;
			}
			case 62: {
				replacement = '&gt;';
				break;
			}
			default: {
				continue;
			}
		}
		out += text.slice(last, i) + replacement;
		last = i + 1;
	}
	return last === 0 ? text : out + text.slice(last);
}

/**
 * React's `escapeTextForBrowser` for an attribute value of any type.
 * @param value - A value that is not a function or a symbol
 * @returns The escaped string
 */
function escapeValue(value: unknown): string {
	if (typeof value === 'string') {
		return escapeText(value);
	}
	if (
		typeof value === 'number' ||
		typeof value === 'bigint' ||
		typeof value === 'boolean'
	) {
		return '' + value;
	}
	return escapeText('' + value);
}

/**
 * Throws React's error for a value that cannot be a child.
 * @param value - The offending object
 */
function invalidChild(value: object): never {
	const tag = Object.prototype.toString.call(value);
	throw new TypeError(
		'Objects are not valid as a React child (found: ' +
			(tag === '[object Object]'
				? 'object with keys {' + Object.keys(value).join(', ') + '}'
				: tag) +
			'). If you meant to render a collection of children, use an array instead.',
	);
}

/**
 * Concatenates the children of an iterable or throws for a plain object.
 * @param value - A non-null object that is neither a `Markup` nor an array
 * @returns The HTML
 */
function childrenOfObject(value: object): string {
	const iteratorFn =
		(value as { [Symbol.iterator]?: unknown })[Symbol.iterator] ??
		(value as { '@@iterator'?: unknown })['@@iterator'];
	if (typeof iteratorFn !== 'function') {
		return invalidChild(value);
	}
	const iterator = (iteratorFn as () => Iterator<unknown>).call(value);
	let out = '';
	if (iterator) {
		for (let step = iterator.next(); !step.done; step = iterator.next()) {
			out += c(step.value);
		}
	}
	return out;
}

/**
 * A child value to HTML. Strings and numbers become escaped text, `Markup`
 * passes through untouched, `null` / `undefined` / booleans / functions /
 * symbols render nothing, arrays and iterables concatenate, anything else
 * throws like React.
 * @param value - A child value
 * @returns HTML
 * @example
 * ```ts
 * c(['a<', 1, null, m('<b/>')]); // 'a&lt;1<b/>'
 * ```
 */
export function c(value: unknown): string {
	if (typeof value === 'string') {
		return escapeText(value);
	}
	if (typeof value === 'object') {
		if (value === null) {
			return '';
		}
		if (value instanceof Markup) {
			return value.html;
		}
		if (Array.isArray(value)) {
			let out = '';
			for (const element of value) {
				out += c(element);
			}
			return out;
		}
		return childrenOfObject(value);
	}
	if (typeof value === 'number' || typeof value === 'bigint') {
		return '' + value;
	}
	return '';
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

interface AttrEntry {
	readonly name: string;
	readonly kind: number;
}

const ATTRS = new Map<string, AttrEntry>();
for (const [prop, name, kind] of PROPS) {
	ATTRS.set(prop, { name, kind });
}
// Consumed by the element (or by React before it sees the props), never written.
for (const prop of ['children', 'key', 'dangerouslySetInnerHTML']) {
	ATTRS.set(prop, { name: prop, kind: RESERVED });
}
const ATTRS_LIMIT = 8192;

const UNITLESS_SET = new Set<string>(UNITLESS);

// Both patterns are copied from React: a `javascript:` URL may hide behind
// control characters, and attribute names follow the XML Name production.
/* eslint-disable no-control-regex, no-misleading-character-class, prefer-regex-literals -- see above */
const JAVASCRIPT_URL =
	/^[\u0000-\u001F ]*j[\n\r\t]*a[\n\r\t]*v[\n\r\t]*a[\n\r\t]*s[\n\r\t]*c[\n\r\t]*r[\n\r\t]*i[\n\r\t]*p[\n\r\t]*t[\n\r\t]*:/i;
const VALID_ATTRIBUTE_NAME = new RegExp(
	'^[:A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD][:\\w\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\-.\\u00B7\\u0300-\\u036F\\u203F\\u2040]*$',
);
/* eslint-enable no-control-regex, no-misleading-character-class, prefer-regex-literals */
const attributeNameSafe = new Map<string, boolean>();

/**
 * React's `isAttributeNameSafe`.
 * @param name - Attribute name
 * @returns Whether the name is a valid XML-ish attribute name
 */
function isAttributeNameSafe(name: string): boolean {
	let safe = attributeNameSafe.get(name);
	if (safe === undefined) {
		safe = VALID_ATTRIBUTE_NAME.test(name);
		if (attributeNameSafe.size < ATTRS_LIMIT) {
			attributeNameSafe.set(name, safe);
		}
	}
	return safe;
}

/**
 * Decides, once per name, how a prop that is not in the generated table is
 * written: React's `default:` branch of `pushAttribute`.
 * @param prop - The prop name
 * @returns The (memoised) entry
 */
function classifyProp(prop: string): AttrEntry {
	let kind: number;
	const c0 = prop.charCodeAt(0);
	const c1 = prop.charCodeAt(1);
	if (prop.length > 2 && (c0 === 111 || c0 === 79) && (c1 === 110 || c1 === 78)) {
		// An event handler (`onClick`, `onload`, ...).
		kind = RESERVED;
	} else if (isAttributeNameSafe(prop)) {
		const prefix = prop.slice(0, 5).toLowerCase();
		// `data-` and `aria-` keep boolean values as the strings "true"/"false".
		kind = prefix === 'data-' || prefix === 'aria-' ? BOOLEANISH_STRING : STRING;
	} else {
		kind = RESERVED;
	}
	const entry: AttrEntry = { name: prop, kind };
	if (ATTRS.size < ATTRS_LIMIT) {
		ATTRS.set(prop, entry);
	}
	return entry;
}

/**
 * Rewrites `javascript:` URLs the way React does.
 * @param url - The URL text
 * @returns The URL or React's replacement
 */
function sanitizeURL(url: string): string {
	const first = url.charCodeAt(0);
	if (first > 32 && first !== 106 && first !== 74) {
		return url;
	}
	return JAVASCRIPT_URL.test(url)
		? "javascript:throw new Error('React has blocked a javascript: URL as a security precaution.')"
		: url;
}

const styleNames = new Map<string, string>();

/**
 * `backgroundColor` to `background-color` (and `msX` to `-ms-x`), escaped.
 * @param name - The style property name
 * @returns The CSS property name chunk
 */
function styleName(name: string): string {
	let chunk = styleNames.get(name);
	if (chunk === undefined) {
		let kebab = '';
		let last = 0;
		for (let i = 0; i < name.length; i++) {
			const code = name.charCodeAt(i);
			if (code >= 65 && code <= 90) {
				kebab += name.slice(last, i) + '-' + name[i];
				last = i + 1;
			}
		}
		kebab = (kebab + name.slice(last)).toLowerCase();
		if (kebab.startsWith('ms-')) {
			kebab = '-' + kebab;
		}
		chunk = escapeText(kebab);
		if (styleNames.size < ATTRS_LIMIT) {
			styleNames.set(name, chunk);
		}
	}
	return chunk;
}

/**
 * The `style` attribute from a style object.
 * @param style - The style object
 * @returns ` style="a:b;c:d"` or an empty string
 */
function styleAttr(style: unknown): string {
	if (typeof style !== 'object' || style === null) {
		throw new Error(
			"The `style` prop expects a mapping from style properties to values, not a string. For example, style={{marginRight: spacing + 'em'}} when using JSX.",
		);
	}
	let out = '';
	let first = true;
	for (const name in style) {
		if (!Object.prototype.hasOwnProperty.call(style, name)) {
			continue;
		}
		const value = (style as Props)[name];
		if (value == null || typeof value === 'boolean' || value === '') {
			continue;
		}
		let nameChunk: string;
		let valueChunk: string;
		if (name.startsWith('--')) {
			nameChunk = escapeText(name);
			valueChunk = escapeText(('' + value).trim());
		} else {
			nameChunk = styleName(name);
			valueChunk =
				typeof value === 'number'
					? value === 0 || UNITLESS_SET.has(name)
						? '' + value
						: value + 'px'
					: escapeText(('' + value).trim());
		}
		out += (first ? ' style="' : ';') + nameChunk + ':' + valueChunk;
		first = false;
	}
	return first ? '' : out + '"';
}

/**
 * React's numeric-attribute test: the global, coercing `isNaN`, so `"abc"` is
 * not a number and `"3"` is.
 * @param value - A non-null value that is not a function or a symbol
 * @returns Whether the value is not a number
 */
function isNotANumber(value: unknown): boolean {
	// eslint-disable-next-line unicorn/prefer-number-properties -- `Number.isNaN("abc")` is false
	return isNaN(value as number);
}

/**
 * Writes one attribute from its table entry.
 * @param entry - The table entry
 * @param value - A non-null value
 * @returns ` name="value"`, ` name=""` or an empty string
 */
function writeAttr(entry: AttrEntry, value: unknown): string {
	const type = typeof value;
	switch (entry.kind) {
		case STRING: {
			if (type === 'function' || type === 'symbol' || type === 'boolean') {
				return '';
			}
			return ' ' + entry.name + '="' + escapeValue(value) + '"';
		}
		case BOOLEANISH_STRING: {
			if (type === 'function' || type === 'symbol') {
				return '';
			}
			return ' ' + entry.name + '="' + escapeValue(value) + '"';
		}
		case BOOLEAN: {
			return value && type !== 'function' && type !== 'symbol'
				? ' ' + entry.name + '=""'
				: '';
		}
		case OVERLOADED_BOOLEAN: {
			if (value === true) {
				return ' ' + entry.name + '=""';
			}
			if (value === false || type === 'function' || type === 'symbol') {
				return '';
			}
			return ' ' + entry.name + '="' + escapeValue(value) + '"';
		}
		case NUMERIC: {
			if (type === 'function' || type === 'symbol' || isNotANumber(value)) {
				return '';
			}
			return ' ' + entry.name + '="' + escapeValue(value) + '"';
		}
		case POSITIVE_NUMERIC: {
			if (
				type === 'function' ||
				type === 'symbol' ||
				isNotANumber(value) ||
				!(1 <= (value as number))
			) {
				return '';
			}
			return ' ' + entry.name + '="' + escapeValue(value) + '"';
		}
		case URL_ATTR:
		case URL_ATTR_KEEP_EMPTY: {
			if (entry.kind === URL_ATTR && value === '') {
				return '';
			}
			if (type === 'function' || type === 'symbol' || type === 'boolean') {
				return '';
			}
			return ' ' + entry.name + '="' + escapeText(sanitizeURL('' + value)) + '"';
		}
		case STYLE: {
			return styleAttr(value);
		}
		default: {
			return '';
		}
	}
}

/**
 * One attribute from a React prop name and a runtime value, as React renders
 * that prop on a host element: attribute renames (`className`, `htmlFor`,
 * SVG camelCase), boolean / overloaded / numeric kinds, URL sanitising, `style`
 * objects, event handlers and reserved props omitted, `data-` / `aria-` kept
 * as strings. `dangerouslySetInnerHTML`, `children` and `key` are never
 * written. A single `Map` lookup on the hot path.
 * @param prop - The React prop name
 * @param value - The runtime value
 * @returns ` name="escaped"`, ` name=""` or an empty string
 * @example
 * ```ts
 * a('className', 'x y'); // ' class="x y"'
 * a('disabled', true); // ' disabled=""'
 * a('onClick', () => {}); // ''
 * ```
 */
export function a(prop: string, value: unknown): string {
	if (value == null) {
		return '';
	}
	return writeAttr(ATTRS.get(prop) ?? classifyProp(prop), value);
}

/**
 * `a()` without the null check, for loops that already skipped null values.
 * @param prop - The React prop name
 * @param value - A non-null value
 * @returns The attribute chunk
 */
function attr(prop: string, value: unknown): string {
	return writeAttr(ATTRS.get(prop) ?? classifyProp(prop), value);
}

// ---------------------------------------------------------------------------
// Render context
// ---------------------------------------------------------------------------

/**
 * Prefix of the position markers `el()` leaves in the output during a render
 * (`MARK h<id>;` for a hoistable, `MARK [` / `MARK ]` around head children).
 * The random part makes it impossible for user text to forge one.
 */
const MARK = '\u0000' + randomUUID() + ':';

const I_CHARSET = 0;
const I_VIEWPORT = 1;
const I_HOIST = 2;
const I_STYLESHEET = 3;
const I_STYLE = 4;
const I_SCRIPT = 5;
const I_IMAGE = 6;

interface Item {
	readonly kind: number;
	/** The rendered chunk (for a `style` item: its rule text). */
	readonly chunk: string;
	/** href / src / image key used for de-duplication. */
	readonly key: string;
	readonly precedence: string;
	/** `fetchPriority="high"` for images. */
	readonly high: boolean;
	/** `type="module"` for scripts. */
	readonly module: boolean;
}

class RenderContext {
	bodyStart: string | null = null;
	headStart: string | null = null;
	htmlStart: string | null = null;
	readonly items: Item[] = [];
}

let rc: RenderContext | null = null;

/** Where an element is rendered, as far as hoisting and `<option>` care. */
interface Scope {
	/** Inside `<svg>`: `title` / `link` / ... stay in place. */
	readonly svg: boolean;
	readonly noscript: boolean;
	readonly picture: boolean;
	/** The enclosing `<select>`'s `value` / `defaultValue`. */
	readonly selected: unknown;
}

const ROOT_SCOPE: Scope = { svg: false, noscript: false, picture: false, selected: null };
let scope: Scope = ROOT_SCOPE;

/**
 * The scope the children of a tag are rendered in.
 * @param tag - The parent tag
 * @param props - The parent's props
 * @returns The scope (the same object when nothing changes)
 */
function childScope(tag: string, props: Props): Scope {
	switch (tag) {
		case 'svg': {
			return scope.svg ? scope : { ...scope, svg: true };
		}
		case 'foreignObject': {
			return scope.svg ? { ...scope, svg: false } : scope;
		}
		case 'noscript': {
			return scope.noscript ? scope : { ...scope, noscript: true };
		}
		case 'picture': {
			return scope.picture ? scope : { ...scope, picture: true };
		}
		case 'select': {
			return {
				svg: false,
				noscript: scope.noscript,
				picture: scope.picture,
				selected: props.value == null ? props.defaultValue : props.value,
			};
		}
		default: {
			return scope;
		}
	}
}

/**
 * Evaluates a children thunk with the parent's scope installed.
 * @param tag - The parent tag
 * @param props - The parent's props
 * @param thunk - The children thunk
 * @returns The evaluated children
 */
function evalThunk(tag: string, props: Props, thunk: () => unknown): unknown {
	const next = childScope(tag, props);
	if (next === scope) {
		return thunk();
	}
	const previous = scope;
	scope = next;
	try {
		return thunk();
	} finally {
		scope = previous;
	}
}

/**
 * Records a hoistable chunk in the current render.
 * @param context - The active render context
 * @param item - The item
 * @returns The position marker to put in the output
 */
function hoist(context: RenderContext, item: Item): string {
	context.items.push(item);
	return MARK + 'h' + (context.items.length - 1) + ';';
}

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

const T_GENERIC = 0;
const T_VOID = 1;
const T_A = 2;
const T_SELECT = 3;
const T_OPTION = 4;
const T_TEXTAREA = 5;
const T_INPUT = 6;
const T_BUTTON = 7;
const T_FORM = 8;
const T_MENUITEM = 9;
const T_OBJECT = 10;
const T_TITLE = 11;
const T_LINK = 12;
const T_SCRIPT = 13;
const T_STYLE = 14;
const T_META = 15;
const T_PRE = 16;
const T_IMG = 17;
const T_HEAD = 18;
const T_BODY = 19;
const T_HTML = 20;
const T_CUSTOM = 21;

interface TagInfo {
	readonly start: string;
	readonly end: string;
	readonly code: number;
}

const TAGS = new Map<string, TagInfo>();
const SIMPLE_VOID = new Set<string>(
	VOID_ELEMENTS.filter((tag) => !['img', 'input', 'link', 'meta'].includes(tag)),
);
const VALID_TAG = /^[a-z][\w:.-]*$/i;
const NOT_CUSTOM = new Set([
	'annotation-xml',
	'color-profile',
	'font-face',
	'font-face-src',
	'font-face-uri',
	'font-face-format',
	'font-face-name',
	'missing-glyph',
]);

/**
 * The tag-specific rendering rule of a tag name (React's `pushStartInstance`
 * switch), validated and memoised.
 * @param tag - The tag name
 * @returns Its info
 */
function makeTag(tag: string): TagInfo {
	if (!VALID_TAG.test(tag)) {
		throw new Error('Invalid tag: ' + tag);
	}
	let code: number;
	switch (tag) {
		case 'a': {
			code = T_A;
			break;
		}
		case 'select': {
			code = T_SELECT;
			break;
		}
		case 'option': {
			code = T_OPTION;
			break;
		}
		case 'textarea': {
			code = T_TEXTAREA;
			break;
		}
		case 'input': {
			code = T_INPUT;
			break;
		}
		case 'button': {
			code = T_BUTTON;
			break;
		}
		case 'form': {
			code = T_FORM;
			break;
		}
		case 'menuitem': {
			code = T_MENUITEM;
			break;
		}
		case 'object': {
			code = T_OBJECT;
			break;
		}
		case 'title': {
			code = T_TITLE;
			break;
		}
		case 'link': {
			code = T_LINK;
			break;
		}
		case 'script': {
			code = T_SCRIPT;
			break;
		}
		case 'style': {
			code = T_STYLE;
			break;
		}
		case 'meta': {
			code = T_META;
			break;
		}
		case 'pre':
		case 'listing': {
			code = T_PRE;
			break;
		}
		case 'img': {
			code = T_IMG;
			break;
		}
		case 'head': {
			code = T_HEAD;
			break;
		}
		case 'body': {
			code = T_BODY;
			break;
		}
		case 'html': {
			code = T_HTML;
			break;
		}
		default: {
			code = SIMPLE_VOID.has(tag)
				? T_VOID
				: tag.includes('-') && !NOT_CUSTOM.has(tag)
					? T_CUSTOM
					: T_GENERIC;
		}
	}
	const info: TagInfo = { start: '<' + tag, end: '</' + tag + '>', code };
	if (TAGS.size < ATTRS_LIMIT) {
		TAGS.set(tag, info);
	}
	return info;
}

/** Set by {@link plainAttrs}: the `dangerouslySetInnerHTML` prop, if any. */
let innerHTMLProp: unknown;

/**
 * The start tag up to (not including) `>` for an element without special
 * attribute rules; `dangerouslySetInnerHTML` is parked in `innerHTMLProp`.
 * @param start - `<tag`
 * @param props - The props
 * @returns The start tag text
 */
function plainAttrs(start: string, props: Props): string {
	let out = start;
	innerHTMLProp = undefined;
	for (const key in props) {
		const value = props[key];
		if (value == null || key === 'children') {
			continue;
		}
		if (key === 'dangerouslySetInnerHTML') {
			innerHTMLProp = value;
			continue;
		}
		out += attr(key, value);
	}
	return out;
}

/**
 * React's `pushInnerHTML`.
 * @param inner - The `dangerouslySetInnerHTML` prop
 * @param children - The element's children
 * @returns The raw HTML to insert
 */
function innerHtml(inner: unknown, children: unknown): string {
	if (children != null) {
		throw new Error('Can only set one of `children` or `props.dangerouslySetInnerHTML`.');
	}
	if (typeof inner !== 'object' || inner === null || !('__html' in inner)) {
		throw new Error(
			'`props.dangerouslySetInnerHTML` must be in the form `{__html: ...}`. Please visit https://react.dev/link/dangerously-set-inner-html for more information.',
		);
	}
	const html = (inner as { __html: unknown }).__html;
	return html === null || html === undefined ? '' : '' + html;
}

/**
 * Throws for children / innerHTML on a self-closing element.
 * @param tag - The tag name
 * @param children - The element's children
 * @param props - The props
 */
function assertSelfClosing(tag: string, children: unknown, props: Props): void {
	if (children != null || props.dangerouslySetInnerHTML != null) {
		throw new Error(
			tag +
				' is a self-closing tag and must neither have `children` nor use `dangerouslySetInnerHTML`.',
		);
	}
}

/**
 * A self-closing element (`<br/>`, `<meta .../>`).
 * @param info - Tag info
 * @param tag - Tag name for the error message
 * @param props - The props
 * @param children - The element's children
 * @returns The element
 */
function selfClosing(
	info: TagInfo,
	tag: string,
	props: Props,
	children: unknown,
): string {
	assertSelfClosing(tag, children, props);
	return plainAttrs(info.start, props) + '/>';
}

/**
 * An ordinary element.
 * @param info - Tag info
 * @param props - The props
 * @param children - The element's children
 * @returns The element
 */
function generic(info: TagInfo, props: Props, children: unknown): string {
	const start = plainAttrs(info.start, props) + '>';
	const inner = innerHTMLProp;
	if (inner != null) {
		return start + innerHtml(inner, children) + info.end;
	}
	return start + c(children) + info.end;
}

/**
 * The text of an `<option>`'s children as React's `flattenOptionChildren`.
 * @param children - Children
 * @returns Their concatenated text
 */
function flattenOption(children: unknown): string {
	if (children == null || typeof children === 'boolean') {
		return '';
	}
	if (typeof children === 'string') {
		return children;
	}
	if (typeof children === 'number' || typeof children === 'bigint') {
		return '' + children;
	}
	if (children instanceof Markup) {
		return children.html;
	}
	if (Array.isArray(children)) {
		let out = '';
		for (const child of children) {
			out += flattenOption(child);
		}
		return out;
	}
	if (typeof children === 'object') {
		return '' + children;
	}
	return '';
}

/**
 * The `<option>` element.
 * @param info - Tag info
 * @param props - The props
 * @param children - The element's children
 * @returns The element
 */
function option(info: TagInfo, props: Props, children: unknown): string {
	let out = info.start;
	let value: unknown = null;
	let selected: unknown = null;
	let inner: unknown = null;
	for (const key in props) {
		const v = props[key];
		if (v == null) {
			continue;
		}
		switch (key) {
			case 'children': {
				break;
			}
			case 'selected': {
				selected = v;
				break;
			}
			case 'dangerouslySetInnerHTML': {
				inner = v;
				break;
			}
			case 'value': {
				value = v;
				out += attr(key, v);
				break;
			}
			default: {
				out += attr(key, v);
			}
		}
	}
	const selectedValue = scope.selected;
	if (selectedValue != null) {
		const text = value === null ? flattenOption(children) : '' + value;
		if (Array.isArray(selectedValue)) {
			for (const candidate of selectedValue) {
				if ('' + candidate === text) {
					out += ' selected=""';
					break;
				}
			}
		} else if ('' + selectedValue === text) {
			out += ' selected=""';
		}
	} else if (selected) {
		out += ' selected=""';
	}
	out += '>';
	if (inner != null) {
		out += innerHtml(inner, children);
	}
	return out + c(children) + info.end;
}

/**
 * The `<select>` element (`value` / `defaultValue` are not attributes).
 * @param info - Tag info
 * @param props - The props
 * @param children - The element's children
 * @returns The element
 */
function select(info: TagInfo, props: Props, children: unknown): string {
	let out = info.start;
	let inner: unknown = null;
	for (const key in props) {
		const v = props[key];
		if (v == null || key === 'children' || key === 'value' || key === 'defaultValue') {
			continue;
		}
		if (key === 'dangerouslySetInnerHTML') {
			inner = v;
			continue;
		}
		out += attr(key, v);
	}
	out += '>';
	if (inner != null) {
		out += innerHtml(inner, children);
	}
	return out + c(children) + info.end;
}

/**
 * The text of a `<textarea>`'s value / children.
 * @param value - The value
 * @returns Escaped text (a `Markup` is taken as escaped)
 */
function textareaText(value: unknown): string {
	return value instanceof Markup ? value.html : escapeText('' + value);
}

/**
 * The `<textarea>` element.
 * @param info - Tag info
 * @param props - The props
 * @param children - The element's children
 * @returns The element
 */
function textarea(info: TagInfo, props: Props, children: unknown): string {
	let out = info.start;
	let value: unknown = null;
	let defaultValue: unknown = null;
	for (const key in props) {
		const v = props[key];
		if (v == null || key === 'children') {
			continue;
		}
		switch (key) {
			case 'value': {
				value = v;
				break;
			}
			case 'defaultValue': {
				defaultValue = v;
				break;
			}
			case 'dangerouslySetInnerHTML': {
				throw new Error('`dangerouslySetInnerHTML` does not make sense on <textarea>.');
			}
			default: {
				out += attr(key, v);
			}
		}
	}
	if (value === null && defaultValue !== null) {
		value = defaultValue;
	}
	out += '>';
	if (children != null) {
		if (value != null) {
			throw new Error(
				'If you supply `defaultValue` on a <textarea>, do not pass children.',
			);
		}
		if (Array.isArray(children) && children.length > 1) {
			throw new Error('<textarea> can only have at most one child.');
		}
		value = children instanceof Markup ? children : '' + children;
	}
	if (typeof value === 'string' && value.charCodeAt(0) === 10) {
		out += '\n';
	}
	if (value !== null) {
		out += textareaText(value);
	}
	return out + info.end;
}

/**
 * Writes ` checked=""`-style attributes.
 * @param name - Attribute name
 * @param value - Value
 * @returns The chunk
 */
function booleanAttr(name: string, value: unknown): string {
	return value && typeof value !== 'function' && typeof value !== 'symbol'
		? ' ' + name + '=""'
		: '';
}

/**
 * The `<input>` element.
 * @param info - Tag info
 * @param props - The props
 * @param children - The element's children
 * @returns The element
 */
function input(info: TagInfo, props: Props, children: unknown): string {
	assertSelfClosing('input', children, props);
	let out = info.start;
	let name: unknown = null;
	let formAction: unknown = null;
	let formEncType: unknown = null;
	let formMethod: unknown = null;
	let formTarget: unknown = null;
	let value: unknown = null;
	let defaultValue: unknown = null;
	let checked: unknown = null;
	let defaultChecked: unknown = null;
	for (const key in props) {
		const v = props[key];
		if (v == null || key === 'children') {
			continue;
		}
		switch (key) {
			case 'name': {
				name = v;
				break;
			}
			case 'formAction': {
				formAction = v;
				break;
			}
			case 'formEncType': {
				formEncType = v;
				break;
			}
			case 'formMethod': {
				formMethod = v;
				break;
			}
			case 'formTarget': {
				formTarget = v;
				break;
			}
			case 'defaultChecked': {
				defaultChecked = v;
				break;
			}
			case 'defaultValue': {
				defaultValue = v;
				break;
			}
			case 'checked': {
				checked = v;
				break;
			}
			case 'value': {
				value = v;
				break;
			}
			default: {
				out += attr(key, v);
			}
		}
	}
	out += formActionAttrs(name, formAction, formEncType, formMethod, formTarget);
	out +=
		checked === null
			? booleanAttr('checked', defaultChecked)
			: booleanAttr('checked', checked);
	if (value !== null) {
		out += attr('value', value);
	} else if (defaultValue !== null) {
		out += attr('value', defaultValue);
	}
	return out + '/>';
}

/**
 * `name` / `formAction` / `formEncType` / `formMethod` / `formTarget`, which
 * React writes after the other attributes of `input` and `button`.
 * @param name - `name`
 * @param formAction - `formAction` (a function is omitted: server actions are not supported)
 * @param formEncType - `formEncType`
 * @param formMethod - `formMethod`
 * @param formTarget - `formTarget`
 * @returns The attribute chunks
 */
function formActionAttrs(
	name: unknown,
	formAction: unknown,
	formEncType: unknown,
	formMethod: unknown,
	formTarget: unknown,
): string {
	let out = '';
	if (name != null) {
		out += attr('name', name);
	}
	if (formAction != null) {
		out += attr('formAction', formAction);
	}
	if (formEncType != null) {
		out += attr('formEncType', formEncType);
	}
	if (formMethod != null) {
		out += attr('formMethod', formMethod);
	}
	if (formTarget != null) {
		out += attr('formTarget', formTarget);
	}
	return out;
}

/**
 * The `<button>` element.
 * @param info - Tag info
 * @param props - The props
 * @param children - The element's children
 * @returns The element
 */
function button(info: TagInfo, props: Props, children: unknown): string {
	let out = info.start;
	let inner: unknown = null;
	let name: unknown = null;
	let formAction: unknown = null;
	let formEncType: unknown = null;
	let formMethod: unknown = null;
	let formTarget: unknown = null;
	for (const key in props) {
		const v = props[key];
		if (v == null || key === 'children') {
			continue;
		}
		switch (key) {
			case 'dangerouslySetInnerHTML': {
				inner = v;
				break;
			}
			case 'name': {
				name = v;
				break;
			}
			case 'formAction': {
				formAction = v;
				break;
			}
			case 'formEncType': {
				formEncType = v;
				break;
			}
			case 'formMethod': {
				formMethod = v;
				break;
			}
			case 'formTarget': {
				formTarget = v;
				break;
			}
			default: {
				out += attr(key, v);
			}
		}
	}
	out += formActionAttrs(name, formAction, formEncType, formMethod, formTarget);
	out += '>';
	if (inner != null) {
		out += innerHtml(inner, children);
	}
	return out + c(children) + info.end;
}

/**
 * The `<form>` element.
 * @param info - Tag info
 * @param props - The props
 * @param children - The element's children
 * @returns The element
 */
function form(info: TagInfo, props: Props, children: unknown): string {
	let out = info.start;
	let inner: unknown = null;
	let action: unknown = null;
	let encType: unknown = null;
	let method: unknown = null;
	let target: unknown = null;
	for (const key in props) {
		const v = props[key];
		if (v == null || key === 'children') {
			continue;
		}
		switch (key) {
			case 'dangerouslySetInnerHTML': {
				inner = v;
				break;
			}
			case 'action': {
				action = v;
				break;
			}
			case 'encType': {
				encType = v;
				break;
			}
			case 'method': {
				method = v;
				break;
			}
			case 'target': {
				target = v;
				break;
			}
			default: {
				out += attr(key, v);
			}
		}
	}
	if (action !== null) {
		// A function action is omitted (see "Deliberate deviations").
		out += attr('action', action);
	}
	if (encType !== null) {
		out += attr('encType', encType);
	}
	if (method !== null) {
		out += attr('method', method);
	}
	if (target !== null) {
		out += attr('target', target);
	}
	out += '>';
	if (inner != null) {
		out += innerHtml(inner, children);
	}
	return out + c(children) + info.end;
}

/**
 * The `<object>` element (`data` is a sanitised URL).
 * @param info - Tag info
 * @param props - The props
 * @param children - The element's children
 * @returns The element
 */
function objectEl(info: TagInfo, props: Props, children: unknown): string {
	let out = info.start;
	let inner: unknown = null;
	for (const key in props) {
		const v = props[key];
		if (v == null || key === 'children') {
			continue;
		}
		if (key === 'dangerouslySetInnerHTML') {
			inner = v;
		} else if (key === 'data') {
			const url = sanitizeURL('' + v);
			if (url !== '') {
				out += ' data="' + escapeText(url) + '"';
			}
		} else {
			out += attr(key, v);
		}
	}
	out += '>';
	if (inner != null) {
		out += innerHtml(inner, children);
	}
	return out + c(children) + info.end;
}

/**
 * The `<a>` element (`href=""` is kept).
 * @param info - Tag info
 * @param props - The props
 * @param children - The element's children
 * @returns The element
 */
function anchor(info: TagInfo, props: Props, children: unknown): string {
	let out = info.start;
	let inner: unknown = null;
	for (const key in props) {
		const v = props[key];
		if (v == null || key === 'children') {
			continue;
		}
		if (key === 'dangerouslySetInnerHTML') {
			inner = v;
		} else if (key === 'href' && v === '') {
			out += ' href=""';
		} else {
			out += attr(key, v);
		}
	}
	out += '>';
	if (inner != null) {
		out += innerHtml(inner, children);
	}
	return out + c(children) + info.end;
}

/**
 * `<pre>` / `<listing>`: a leading newline in the content is doubled.
 * @param info - Tag info
 * @param props - The props
 * @param children - The element's children
 * @returns The element
 */
function pre(info: TagInfo, props: Props, children: unknown): string {
	let out = plainAttrs(info.start, props) + '>';
	const inner = innerHTMLProp;
	if (inner != null) {
		const html = innerHtml(inner, children);
		out += html.charCodeAt(0) === 10 ? '\n' + html : html;
	}
	if (typeof children === 'string' && children.charCodeAt(0) === 10) {
		out += '\n';
	}
	return out + c(children) + info.end;
}

/**
 * A custom element (a dash in the tag name): attribute names pass through.
 * @param info - Tag info
 * @param props - The props
 * @param children - The element's children
 * @returns The element
 */
function custom(info: TagInfo, props: Props, children: unknown): string {
	let out = info.start;
	let inner: unknown = null;
	for (const key in props) {
		const v = props[key];
		if (v == null) {
			continue;
		}
		switch (key) {
			case 'children':
			case 'key':
			case 'suppressContentEditableWarning':
			case 'suppressHydrationWarning':
			case 'ref': {
				break;
			}
			case 'dangerouslySetInnerHTML': {
				inner = v;
				break;
			}
			case 'style': {
				out += styleAttr(v);
				break;
			}
			default: {
				if (
					!isAttributeNameSafe(key) ||
					typeof v === 'function' ||
					typeof v === 'symbol' ||
					v === false
				) {
					break;
				}
				if (typeof v === 'object') {
					break;
				}
				out +=
					' ' +
					(key === 'className' ? 'class' : key) +
					'="' +
					(v === true ? '' : escapeValue(v)) +
					'"';
			}
		}
	}
	out += '>';
	if (inner != null) {
		out += innerHtml(inner, children);
	}
	return out + c(children) + info.end;
}

const SCRIPT_TAG = /(<\/|<)(s)(cript)/gi;
const STYLE_TAG = /(<\/|<)(s)(tyle)/gi;

/**
 * Keeps a `</script` inside script text from closing the element.
 * @param text - Script text
 * @returns Text with `<script` / `</script` rewritten as React does
 */
function escapeScript(text: string): string {
	return text.includes('<')
		? text.replaceAll(
				SCRIPT_TAG,
				(_match, prefix: string, s: string, suffix: string) =>
					prefix + (s === 's' ? '\\u0073' : '\\u0053') + suffix,
			)
		: text;
}

/**
 * Keeps a `</style` inside style text from closing the element.
 * @param text - Style text
 * @returns Text with `<style` / `</style` rewritten as React does
 */
function escapeStyle(text: string): string {
	return text.includes('<')
		? text.replaceAll(
				STYLE_TAG,
				(_match, prefix: string, s: string, suffix: string) =>
					prefix + (s === 's' ? '\\73 ' : '\\53 ') + suffix,
			)
		: text;
}

/**
 * The text React writes for a `<title>` / `<style>` child: a lone child of an
 * array, or a non-array child; functions, symbols and null are dropped.
 * @param children - The element's children
 * @returns The single child, or `undefined`
 */
function singleChild(children: unknown): unknown {
	const child = Array.isArray(children)
		? children.length < 2
			? children[0]
			: null
		: children;
	return typeof child === 'function' || typeof child === 'symbol' ? undefined : child;
}

/**
 * A `<title>` element.
 * @param props - The props
 * @param children - The element's children
 * @returns The element
 */
function titleChunk(props: Props, children: unknown): string {
	let out = plainAttrs('<title', props) + '>';
	const inner = innerHTMLProp;
	const child = singleChild(children);
	if (child !== null && child !== undefined) {
		out += child instanceof Markup ? child.html : escapeText('' + child);
	}
	if (inner != null) {
		out += innerHtml(inner, children);
	}
	return out + '</title>';
}

/**
 * A `<script>` element.
 * @param props - The props
 * @param children - The element's children
 * @returns The element
 */
function scriptChunk(props: Props, children: unknown): string {
	let out = plainAttrs('<script', props) + '>';
	const inner = innerHTMLProp;
	if (inner != null) {
		out += innerHtml(inner, children);
	}
	if (typeof children === 'string') {
		out += escapeScript(children);
	}
	return out + '</script>';
}

/**
 * The text and innerHTML of a `<style>`.
 * @param children - The element's children
 * @param inner - The `dangerouslySetInnerHTML` prop
 * @returns Escaped-for-style text followed by the raw innerHTML
 */
function styleBody(children: unknown, inner: unknown): string {
	let out = '';
	const child = singleChild(children);
	if (child !== null && child !== undefined) {
		out += escapeStyle(child instanceof Markup ? child.html : '' + child);
	}
	if (inner != null) {
		out += innerHtml(inner, children);
	}
	return out;
}

/**
 * A `<link>` element.
 * @param props - The props
 * @param asStylesheet - Write `precedence` as `data-precedence` at the end
 * @param children - The element's children (a hoisted stylesheet ignores them, like React)
 * @returns The element
 */
function linkChunk(
	props: Props,
	asStylesheet: boolean,
	children: unknown = null,
): string {
	if (children != null) {
		throw new Error(
			'link is a self-closing tag and must neither have `children` nor use `dangerouslySetInnerHTML`.',
		);
	}
	let out = '<link';
	let wroteData = false;
	for (const key in props) {
		const value = props[key];
		if (value == null) {
			continue;
		}
		if (key === 'children' || key === 'dangerouslySetInnerHTML') {
			throw new Error(
				'link is a self-closing tag and must neither have `children` nor use `dangerouslySetInnerHTML`.',
			);
		}
		if (asStylesheet) {
			if (key === 'precedence') {
				continue;
			}
			if (key === 'data-precedence') {
				out += attr(key, props.precedence);
				wroteData = true;
				continue;
			}
		}
		out += attr(key, value);
	}
	if (asStylesheet && !wroteData) {
		out += attr('data-precedence', props.precedence);
	}
	return out + '/>';
}

/**
 * Whether a string starts with `data:` (any case).
 * @param value - A URL
 * @returns Whether it is a data URL
 */
function isDataURL(value: string): boolean {
	return (
		value[4] === ':' &&
		(value[0] === 'd' || value[0] === 'D') &&
		(value[1] === 'a' || value[1] === 'A') &&
		(value[2] === 't' || value[2] === 'T') &&
		(value[3] === 'a' || value[3] === 'A')
	);
}

/**
 * Registers the head preload React emits for an `<img>`; returns the marker
 * to put in front of the image, or an empty string when React emits none.
 * @param context - The active render context
 * @param props - The image's props
 * @returns The marker or `''`
 */
function imagePreload(context: RenderContext, props: Props): string {
	const src = props.src;
	const srcSet = props.srcSet;
	if (
		props.loading === 'lazy' ||
		(!src && !srcSet) ||
		(typeof src !== 'string' && src != null) ||
		(typeof srcSet !== 'string' && srcSet != null) ||
		props.fetchPriority === 'low' ||
		(typeof src === 'string' && isDataURL(src)) ||
		(typeof srcSet === 'string' && isDataURL(srcSet))
	) {
		return '';
	}
	const sizes = typeof props.sizes === 'string' ? props.sizes : undefined;
	const key = srcSet ? srcSet + '\n' + (sizes || '') : (src as string);
	const crossOrigin =
		typeof props.crossOrigin === 'string'
			? props.crossOrigin === 'use-credentials'
				? props.crossOrigin
				: ''
			: undefined;
	const chunk = linkChunk(
		{
			rel: 'preload',
			as: 'image',
			href: srcSet ? undefined : src,
			imageSrcSet: srcSet,
			imageSizes: sizes,
			crossOrigin,
			integrity: props.integrity,
			type: props.type,
			fetchPriority: props.fetchPriority,
			referrerPolicy: props.referrerPolicy,
		},
		false,
	);
	return hoist(context, {
		kind: I_IMAGE,
		chunk,
		key,
		precedence: '',
		high: props.fetchPriority === 'high',
		module: false,
	});
}

/**
 * Generic host element for everything the compiler cannot flatten: dynamic
 * tag names, spreads, and every element whose rendering depends on context.
 * `props` uses React prop names. `children` is the already-evaluated child
 * value (as for {@link c}), or a zero-argument function returning it, which is
 * called with the parent's context installed (needed by `select`, `svg`,
 * `foreignObject`, `noscript` and `picture`). When `children` is omitted,
 * `props.children` is used; an explicit `undefined` overrides it.
 *
 * Void elements render `<br/>`; `<pre>`, `<textarea>` and `<listing>` double a
 * leading newline; hoistable elements (`title`, `meta`, `link`,
 * `script async src`, `style precedence href`) move into the document head
 * when called inside {@link render} and render in place otherwise.
 * @param tag - The tag name
 * @param props - React props (may hold `dangerouslySetInnerHTML`, `value`, ...)
 * @param children - The children value or a thunk returning it
 * @returns The element
 * @example
 * ```ts
 * el('br', null).html; // '<br/>'
 * el('a', { href: '/x', className: 'k' }, 'go').html; // '<a href="/x" class="k">go</a>'
 * ```
 */
export function el(tag: string, props: Props | null, children?: unknown): Markup {
	const p = props ?? EMPTY_PROPS;
	const info = TAGS.get(tag) ?? makeTag(tag);
	let ch: unknown;

	if (arguments.length < 3) {
		ch = p.children;
	} else if (typeof children === 'function') {
		ch = evalThunk(tag, p, children as () => unknown);
	} else {
		ch = children;
	}
	switch (info.code) {
		case T_VOID: {
			return new Markup(selfClosing(info, tag, p, ch));
		}
		case T_A: {
			return new Markup(anchor(info, p, ch));
		}
		case T_SELECT: {
			return new Markup(select(info, p, ch));
		}
		case T_OPTION: {
			return new Markup(option(info, p, ch));
		}
		case T_TEXTAREA: {
			return new Markup(textarea(info, p, ch));
		}
		case T_INPUT: {
			return new Markup(input(info, p, ch));
		}
		case T_BUTTON: {
			return new Markup(button(info, p, ch));
		}
		case T_FORM: {
			return new Markup(form(info, p, ch));
		}
		case T_MENUITEM: {
			if (ch != null || p.dangerouslySetInnerHTML != null) {
				throw new Error(
					'menuitems cannot have `children` nor `dangerouslySetInnerHTML`.',
				);
			}
			return new Markup(plainAttrs(info.start, p) + '>' + info.end);
		}
		case T_OBJECT: {
			return new Markup(objectEl(info, p, ch));
		}
		case T_PRE: {
			return new Markup(pre(info, p, ch));
		}
		case T_CUSTOM: {
			return new Markup(custom(info, p, ch));
		}
		case T_TITLE: {
			const chunk = titleChunk(p, ch);
			if (rc === null || scope.svg || scope.noscript || p.itemProp != null) {
				return new Markup(chunk);
			}
			return new Markup(
				hoist(rc, {
					kind: I_HOIST,
					chunk,
					key: '',
					precedence: '',
					high: false,
					module: false,
				}),
			);
		}
		case T_META: {
			const chunk = selfClosing(info, 'meta', p, ch);
			if (rc === null || scope.svg || scope.noscript || p.itemProp != null) {
				return new Markup(chunk);
			}
			const kind =
				typeof p.charSet === 'string'
					? I_CHARSET
					: p.name === 'viewport'
						? I_VIEWPORT
						: I_HOIST;
			return new Markup(
				hoist(rc, { kind, chunk, key: '', precedence: '', high: false, module: false }),
			);
		}
		case T_LINK: {
			return new Markup(linkEl(p, ch));
		}
		case T_SCRIPT: {
			const chunk = scriptChunk(p, ch);
			const src = p.src;
			const async = p.async;
			if (
				rc === null ||
				typeof src !== 'string' ||
				!src ||
				!async ||
				typeof async === 'function' ||
				typeof async === 'symbol' ||
				p.onLoad ||
				p.onError ||
				scope.svg ||
				scope.noscript ||
				p.itemProp != null
			) {
				return new Markup(chunk);
			}
			return new Markup(
				hoist(rc, {
					kind: I_SCRIPT,
					chunk,
					key: src,
					precedence: '',
					high: false,
					module: p.type === 'module',
				}),
			);
		}
		case T_STYLE: {
			return new Markup(styleEl(p, ch));
		}
		case T_IMG: {
			const chunk = selfClosing(info, 'img', p, ch);
			if (rc === null || scope.noscript || scope.picture) {
				return new Markup(chunk);
			}
			return new Markup(imagePreload(rc, p) + chunk);
		}
		case T_HEAD: {
			if (rc === null) {
				return new Markup(generic(info, p, ch));
			}
			if (rc.headStart !== null) {
				throw new Error('The `<head>` tag may only be rendered once.');
			}
			const start = plainAttrs(info.start, p) + '>';
			const inner = innerHTMLProp;
			rc.headStart = inner == null ? start : start + innerHtml(inner, ch);
			return new Markup(MARK + '[' + c(ch) + MARK + ']');
		}
		case T_BODY: {
			if (rc === null) {
				return new Markup(generic(info, p, ch));
			}
			if (rc.bodyStart !== null) {
				throw new Error('The `<body>` tag may only be rendered once.');
			}
			const start = plainAttrs(info.start, p) + '>';
			const inner = innerHTMLProp;
			rc.bodyStart = inner == null ? start : start + innerHtml(inner, ch);
			return new Markup(c(ch));
		}
		case T_HTML: {
			if (rc === null) {
				return new Markup(generic(info, p, ch));
			}
			if (rc.htmlStart !== null) {
				throw new Error('The `<html>` tag may only be rendered once.');
			}
			const start = plainAttrs(info.start, p) + '>';
			const inner = innerHTMLProp;
			rc.htmlStart = inner == null ? start : start + innerHtml(inner, ch);
			return new Markup(c(ch));
		}
		default: {
			return new Markup(generic(info, p, ch));
		}
	}
}

/**
 * A `<link>`: stylesheets with a precedence and other links are hoisted.
 * @param props - The props
 * @param children - The element's children
 * @returns The element or a hoisting marker
 */
function linkEl(props: Props, children: unknown): string {
	const { rel, href, precedence } = props;
	const context = rc;
	if (
		context === null ||
		scope.svg ||
		scope.noscript ||
		props.itemProp != null ||
		typeof rel !== 'string' ||
		typeof href !== 'string' ||
		href === ''
	) {
		return linkChunk(props, false, children);
	}
	if (rel === 'stylesheet') {
		if (
			typeof precedence !== 'string' ||
			props.disabled != null ||
			props.onLoad ||
			props.onError
		) {
			return linkChunk(props, false, children);
		}
		return hoist(context, {
			kind: I_STYLESHEET,
			chunk: linkChunk(props, true),
			key: href,
			precedence,
			high: false,
			module: false,
		});
	}
	if (props.onLoad || props.onError) {
		return linkChunk(props, false, children);
	}
	return hoist(context, {
		kind: I_HOIST,
		chunk: linkChunk(props, false, children),
		key: '',
		precedence: '',
		high: false,
		module: false,
	});
}

/**
 * A `<style>`: with `precedence` and `href` it is hoisted into the head.
 * @param props - The props
 * @param children - The element's children
 * @returns The element or a hoisting marker
 */
function styleEl(props: Props, children: unknown): string {
	const { precedence, href } = props;
	const context = rc;
	if (
		context === null ||
		scope.svg ||
		scope.noscript ||
		props.itemProp != null ||
		typeof precedence !== 'string' ||
		typeof href !== 'string' ||
		href === ''
	) {
		const start = plainAttrs('<style', props) + '>';
		const inner = innerHTMLProp;
		return start + styleBody(children, inner) + '</style>';
	}
	const inner = props.dangerouslySetInnerHTML;
	return hoist(context, {
		kind: I_STYLE,
		chunk: styleBody(children, inner),
		key: href,
		precedence,
		high: false,
		module: false,
	});
}

/**
 * Registers the head `<link rel="preload" as="image">` React emits for an
 * `<img>`, for images the compiler flattened into a constant. A no-op outside
 * {@link render} or inside `noscript` / `picture`. The compiler calls it where
 * the image would be evaluated and puts the returned marker string in front of
 * the image's HTML.
 * @param props - The image's `src` / `srcSet` / `sizes` / `loading` / ... props
 * @returns A position marker to prepend to the image's HTML, or `''`
 * @example
 * ```ts
 * m(preloadImage({ src: '/a.png' }) + '<img src="/a.png"/>');
 * ```
 */
export function preloadImage(props: Props): string {
	if (rc === null || scope.noscript || scope.picture) {
		return '';
	}
	return imagePreload(rc, props);
}

// ---------------------------------------------------------------------------
// Components and the document
// ---------------------------------------------------------------------------

/** The fragment element type (`Symbol.for('react.fragment')`). */
export const Fragment = Symbol.for('react.fragment');

/**
 * Calls a component: a function component is called with `props` (children
 * already evaluated), a string tag is rendered through {@link el} with
 * `props.children`, and {@link Fragment} concatenates its children. The result
 * is coerced like React child content.
 * @param type - A component function, a tag name or `Fragment`
 * @param props - The props, `children` included
 * @returns The rendered markup
 * @example
 * ```ts
 * k((p: { n: number }) => m('<i>' + p.n + '</i>'), { n: 1 }).html; // '<i>1</i>'
 * ```
 */
export function k(type: unknown, props: Props): Markup {
	if (typeof type === 'function') {
		const result = (type as (props: Props) => unknown)(props);
		return result instanceof Markup
			? result
			: result == null
				? EMPTY
				: new Markup(c(result));
	}
	if (typeof type === 'string') {
		return el(type, props);
	}
	if (type === Fragment) {
		return new Markup(c(props.children));
	}
	throw new Error(
		'Element type is invalid: expected a string (for built-in components) or a function (for composite components) but got: ' +
			(type === null ? 'null' : typeof type) +
			'.',
	);
}

const CATEGORY_IMAGE_HIGH_LIMIT = 10;

interface StyleQueue {
	readonly precedence: string;
	readonly sheets: string[];
	readonly hrefs: string[];
	readonly rules: string[];
}

interface ImageResource {
	chunk: string;
}

/**
 * Walks the rendered root once in document order and assembles the document
 * the way React's `flushCompletedQueues` does.
 * @param context - The finished render context
 * @param root - The root output with position markers
 * @returns The final HTML
 */
function assemble(context: RenderContext, root: string): string {
	let main = '';
	let head = '';
	let inHead = false;
	let from = 0;
	let pos = 0;

	let charset = '';
	let viewport = '';
	let hoistable = '';
	let scripts = '';
	const styleResources = new Set<string>();
	const scriptResources = new Set<string>();
	const moduleResources = new Set<string>();
	const imageResources = new Set<string>();
	const queues = new Map<string, StyleQueue>();
	const highImages: ImageResource[] = [];
	const bulkImages: ImageResource[] = [];
	const promotable = new Map<string, ImageResource>();

	const resolve = (item: Item): void => {
		switch (item.kind) {
			case I_CHARSET: {
				charset += item.chunk;
				break;
			}
			case I_VIEWPORT: {
				viewport += item.chunk;
				break;
			}
			case I_HOIST: {
				hoistable += item.chunk;
				break;
			}
			case I_STYLESHEET:
			case I_STYLE: {
				if (styleResources.has(item.key)) {
					break;
				}
				styleResources.add(item.key);
				let queue = queues.get(item.precedence);
				if (queue === undefined) {
					queue = {
						precedence: escapeText(item.precedence),
						sheets: [],
						hrefs: [],
						rules: [],
					};
					queues.set(item.precedence, queue);
				}
				if (item.kind === I_STYLESHEET) {
					queue.sheets.push(item.chunk);
				} else {
					queue.hrefs.push(escapeText(item.key));
					queue.rules.push(item.chunk);
				}
				break;
			}
			case I_SCRIPT: {
				const seen = item.module ? moduleResources : scriptResources;
				if (!seen.has(item.key)) {
					seen.add(item.key);
					scripts += item.chunk;
				}
				break;
			}
			case I_IMAGE: {
				const existing = promotable.get(item.key);
				if (existing === undefined) {
					if (!imageResources.has(item.key)) {
						imageResources.add(item.key);
						const resource: ImageResource = { chunk: item.chunk };
						if (item.high || highImages.length < CATEGORY_IMAGE_HIGH_LIMIT) {
							highImages.push(resource);
						} else {
							bulkImages.push(resource);
							promotable.set(item.key, resource);
						}
					}
				} else if (item.high || highImages.length < CATEGORY_IMAGE_HIGH_LIMIT) {
					promotable.delete(item.key);
					highImages.push(existing);
				}
				break;
			}
			default: {
				break;
			}
		}
	};

	const markLength = MARK.length;
	for (;;) {
		const i = root.indexOf(MARK, pos);
		if (i === -1) {
			break;
		}
		const next = root.charCodeAt(i + markLength);
		if (next === 104) {
			const end = root.indexOf(';', i + markLength + 1);
			if (end !== -1) {
				const id = Number(root.slice(i + markLength + 1, end));
				const item = Number.isInteger(id) ? context.items[id] : undefined;
				if (item !== undefined) {
					if (inHead) {
						head += root.slice(from, i);
					} else {
						main += root.slice(from, i);
					}
					from = end + 1;
					pos = from;
					resolve(item);
					continue;
				}
			}
		} else if ((next === 91 && !inHead) || (next === 93 && inHead)) {
			if (inHead) {
				head += root.slice(from, i);
			} else {
				main += root.slice(from, i);
			}
			inHead = next === 91;
			from = i + markLength + 1;
			pos = from;
			continue;
		}
		pos = i + 1;
	}
	if (inHead) {
		head += root.slice(from);
	} else {
		main += root.slice(from);
	}

	let out = '';
	if (context.htmlStart !== null) {
		out += context.htmlStart + (context.headStart ?? '<head>');
	} else if (context.headStart !== null) {
		out += context.headStart;
	}
	out += charset + viewport;
	for (const resource of highImages) {
		out += resource.chunk;
		resource.chunk = '';
	}
	for (const queue of queues.values()) {
		out += queue.sheets.join('');
		if (queue.sheets.length === 0 || queue.hrefs.length > 0) {
			out +=
				'<style data-precedence="' +
				queue.precedence +
				(queue.hrefs.length > 0 ? '" data-href="' + queue.hrefs.join(' ') : '') +
				'">' +
				queue.rules.join('') +
				'</style>';
		}
	}
	out += scripts;
	for (const resource of bulkImages) {
		out += resource.chunk;
	}
	out += hoistable + head;
	if (context.htmlStart !== null || context.headStart !== null) {
		out += '</head>';
	}
	if (context.bodyStart !== null) {
		out += context.bodyStart;
	}
	out += main;
	if (context.bodyStart !== null) {
		out += '</body>';
	}
	if (context.htmlStart !== null) {
		out += '</html>';
	}
	return out;
}

/**
 * Top-level entry of a build: renders `component(props)` the way
 * `renderToStaticMarkup(createElement(component, props))` would, including
 * React 19's document-level behaviour (hoisting into the head, the preamble
 * order, de-duplication, the `<html>` / `<head>` / `<body>` skeleton), and
 * returns the final string. Rendering is synchronous; a render started inside
 * a component is isolated from the outer one.
 * @param component - The page component
 * @param props - Its props (`children` already evaluated if any)
 * @returns The HTML
 * @example
 * ```ts
 * render(() => el('html', { lang: 'ja' }, [el('head', null, el('title', null, 'T')), el('body', null, 'x')]), {});
 * // '<html lang="ja"><head><title>T</title></head><body>x</body></html>'
 * ```
 */
export function render<P extends Props>(
	component: (props: P) => unknown,
	props: P,
): string {
	const previousContext = rc;
	const previousScope = scope;
	const context = new RenderContext();
	rc = context;
	scope = ROOT_SCOPE;
	try {
		const root = c(component(props));
		if (
			context.items.length === 0 &&
			context.htmlStart === null &&
			context.headStart === null &&
			context.bodyStart === null
		) {
			return root;
		}
		return assemble(context, root);
	} finally {
		rc = previousContext;
		scope = previousScope;
	}
}
