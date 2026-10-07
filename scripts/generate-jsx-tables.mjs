/**
 * Generates the React DOM attribute tables used by kamado v3's JSX runtime:
 *
 * - `packages/kamado/src/jsx/attr-table.ts` (read by `runtime.ts`)
 * - `crates/kd_js/src/react_attrs.rs` (read by the Rust JSX compiler)
 *
 * The tables are read out of the installed react-dom's server build
 * (`react-dom-server-legacy.node.production.js`, the code behind
 * `renderToStaticMarkup`) rather than hand-copied:
 *
 * - `aliases`, `unitlessNumbers` are parsed from their literal definitions;
 * - the per-prop kinds are parsed from the `case "...":` groups of
 * `pushAttribute`, each group is classified by the handler it runs and an
 * unknown handler aborts the generation, so a React upgrade that adds a new
 * shape fails loudly instead of silently producing a wrong table;
 * - the void elements are the labels of the "no end tag" switch in
 * `renderElement` (minus the elements that merely have no *separate* end tag).
 *
 * Nothing is probed by rendering. Run it when react-dom is upgraded:
 * `node scripts/generate-jsx-tables.mjs`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dir = path.join(root, 'node_modules', 'react-dom');
const source = readFileSync(
	path.join(dir, 'cjs', 'react-dom-server-legacy.node.production.js'),
	'utf8',
);
const version = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version;

const STRING = 0;
const BOOLEAN = 1;
const OVERLOADED_BOOLEAN = 2;
const NUMERIC = 3;
const POSITIVE_NUMERIC = 4;
const BOOLEANISH_STRING = 5;
const RESERVED = 6;
const URL_ATTR = 7;
const URL_ATTR_KEEP_EMPTY = 8;
const STYLE = 9;

const KIND_NAMES = [
	'STRING',
	'BOOLEAN',
	'OVERLOADED_BOOLEAN',
	'NUMERIC',
	'POSITIVE_NUMERIC',
	'BOOLEANISH_STRING',
	'RESERVED',
	'URL_ATTR',
	'URL_ATTR_KEEP_EMPTY',
	'STYLE',
];

/**
 * Returns the source between two markers.
 * @param {string} from - Start marker (included)
 * @param {string} to - End marker (excluded)
 * @returns {string} The slice
 */
function between(from, to) {
	const start = source.indexOf(from);
	if (start === -1) {
		throw new Error(`marker not found: ${from}`);
	}
	const end = source.indexOf(to, start);
	if (end === -1) {
		throw new Error(`marker not found: ${to}`);
	}
	return source.slice(start, end);
}

/**
 * Reads `unitlessNumbers = new Set("a b c".split(" "))`.
 * @returns {string[]} The style property names, sorted
 */
function readUnitless() {
	const body = between('unitlessNumbers = new Set(', 'aliases = new Map(');
	const match = /"([^"]+)"\.split/.exec(body);
	if (!match) {
		throw new Error('unitlessNumbers literal not found');
	}
	return [...new Set(match[1].split(' '))].toSorted();
}

/**
 * Reads `aliases = new Map([["a", "b"], ...])`.
 * @returns {[string, string][]} Prop name to attribute name pairs
 */
function readAliases() {
	const body = between('aliases = new Map(', 'matchHtmlRegExp');
	const pairs = [];
	const re = /\["([^"]+)",\s*"([^"]+)"\]/g;
	let m;
	while ((m = re.exec(body))) {
		pairs.push([m[1], m[2]]);
	}
	if (pairs.length < 50) {
		throw new Error(`suspiciously few aliases: ${pairs.length}`);
	}
	return pairs;
}

/**
 * Splits the `switch (name)` of `pushAttribute` into groups of case labels and
 * the handler source that follows them (whitespace removed).
 * @returns {{ labels: string[], pre: string, handler: string }[]} The groups.
 * A group that falls through from a guard (`src` / `href`) reports the guard
 * in `pre` and the labels that precede it in `preLabels`.
 */
function readPushAttributeGroups() {
	const body = between('function pushAttribute(', 'function pushInnerHTML(');
	const lines = body.split('\n').map((line) => line.trim());
	const groups = [];
	let labels = [];
	let preLabels = null;
	let pre = '';
	let handler = [];
	let previous = '';
	for (const line of lines) {
		const wasPrevious = previous;
		previous = line;
		if (line.startsWith('default:')) {
			break;
		}
		const label = /^case "([^"]+)":$/.exec(line);
		if (label) {
			if (handler.length > 0) {
				// Fall-through from a guard to the next labels.
				preLabels = labels;
				pre = handler.join('').replaceAll(/\s+/g, '');
				labels = [];
				handler = [];
			}
			labels.push(label[1]);
			continue;
		}
		if (labels.length === 0) {
			continue;
		}
		// A lone `break;` right after `)` is the body of an `if (...)` guard.
		if (line === 'break;' && wasPrevious !== ')') {
			groups.push({
				labels: preLabels ? [...preLabels, ...labels] : labels,
				preLabels: preLabels ?? [],
				pre,
				handler: handler.join('').replaceAll(/\s+/g, ''),
			});
			labels = [];
			preLabels = null;
			pre = '';
			handler = [];
			continue;
		}
		handler.push(line);
	}
	return groups;
}

/**
 * Turns the handler of one group into [kind, attribute name resolver].
 * @param {{ labels: string[], preLabels: string[], pre: string, handler: string }} group - A parsed group
 * @returns {[string, number, string][]} (prop, kind, attribute name) triples
 */
function classify(group) {
	const { labels, preLabels, pre, handler } = group;
	/** @type {[string, number, string][]} */
	const out = [];
	/**
	 * Adds every label with one kind and a name function.
	 * @param {number} kind - The kind
	 * @param {(label: string) => string} [nameOf] - Attribute name of a label
	 * @param {string[]} [only] - Restrict to these labels
	 */
	const add = (kind, nameOf = (label) => label, only = labels) => {
		for (const label of only) {
			out.push([label, kind, nameOf(label)]);
		}
	};
	// Handlers are compared with all whitespace removed (also inside string
	// literals), so `" "` reads as `""` below.
	let m;
	if ((m = /^pushStringAttribute\(target,"([^"]+)",value\);$/.exec(handler))) {
		add(STRING, () => m[1]);
	} else if (handler === 'pushStringAttribute(target,name,value);') {
		add(STRING);
	} else if (handler === 'pushStyleAttribute(target,value);') {
		add(STYLE);
	} else if (
		pre === 'if(""===value)break;' &&
		handler.startsWith('if(null==value||"function"===typeofvalue') &&
		handler.includes('sanitizeURL(""+value)')
	) {
		// `src` / `href`: an empty string is dropped before the shared URL path.
		add(URL_ATTR, undefined, preLabels);
		add(
			URL_ATTR_KEEP_EMPTY,
			undefined,
			labels.filter((l) => !preLabels.includes(l)),
		);
	} else if (handler === '') {
		// `defaultValue ... ref`: the handler is just `break;`
		add(RESERVED);
	} else if (handler === 'pushBooleanAttribute(target,name.toLowerCase(),value);') {
		add(BOOLEAN, (label) => label.toLowerCase());
	} else if (
		handler.startsWith(
			'if("function"===typeofvalue||"symbol"===typeofvalue||"boolean"===typeofvalue)break;value=sanitizeURL(""+value);target.push("","xlink:href"',
		)
	) {
		add(URL_ATTR_KEEP_EMPTY, () => 'xlink:href');
	} else if (
		handler.startsWith(
			'"function"!==typeofvalue&&"symbol"!==typeofvalue&&!isNaN(value)&&1<=value&&',
		)
	) {
		add(POSITIVE_NUMERIC);
	} else if (
		handler.startsWith(
			'"function"!==typeofvalue&&"symbol"!==typeofvalue&&target.push("",name,\'="\',escapeTextForBrowser(value),\'"\');',
		)
	) {
		add(BOOLEANISH_STRING);
	} else if (
		handler.startsWith(
			'value&&"function"!==typeofvalue&&"symbol"!==typeofvalue&&target.push("",name,\'=""\');',
		)
	) {
		add(BOOLEAN);
	} else if (handler.startsWith('!0===value?target.push("",name,\'=""\')')) {
		add(OVERLOADED_BOOLEAN);
	} else if (
		handler.startsWith('"function"===typeofvalue||"symbol"===typeofvalue||isNaN(value)||')
	) {
		add(NUMERIC);
	} else {
		throw new Error(
			`unrecognised pushAttribute handler for [${labels.join(', ')}]: ${handler}`,
		);
	}
	return out;
}

/**
 * Reads the elements React writes as `<tag .../>` and never closes.
 * @returns {string[]} The tag names, sorted
 */
function readVoidElements() {
	const body = between('task = newProps.chunks;', 'break a;');
	const tags = [...body.matchAll(/case "([^"]+)":/g)].map((m) => m[1]);
	return tags.filter((t) => !['title', 'style', 'script'].includes(t)).toSorted();
}

const unitless = readUnitless();
const voidElements = readVoidElements();

/** @type {Map<string, [string, number]>} */
const props = new Map();
for (const [prop, name] of readAliases()) {
	if (prop !== name) {
		props.set(prop, [name, STRING]);
	}
}
for (const group of readPushAttributeGroups()) {
	for (const [prop, kind, name] of classify(group)) {
		if (props.has(prop)) {
			throw new Error(`duplicate prop ${prop}`);
		}
		// A plain string kind with an unchanged name is the default path.
		if (kind === STRING && name === prop) {
			continue;
		}
		props.set(prop, [name, kind]);
	}
}
const rows = [...props.entries()]
	.map(([prop, [name, kind]]) => [prop, name, kind])
	.toSorted((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));

const banner = `@generated by scripts/generate-jsx-tables.mjs — do not edit by hand.
Source: react-dom ${version} (cjs/react-dom-server-legacy.node.production.js), read as
text; nothing is probed by rendering.`;

/**
 * Quotes a string for TypeScript.
 * @param {string} value - The string
 * @returns {string} A single-quoted literal
 */
function ts(value) {
	return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

const tsLines = [];
for (const line of banner.split('\n')) {
	tsLines.push(`// ${line}`);
}
tsLines.push(
	'',
	'/** Attribute kinds; the numbers are shared with `crates/kd_js/src/react_attrs.rs`. */',
);
for (const [index, name] of KIND_NAMES.entries()) {
	tsLines.push(`export const ${name} = ${index};`);
}
tsLines.push(
	'',
	'/** `[React prop name, HTML attribute name as React writes it, kind]`, sorted by prop name. */',
	'export const PROPS: readonly (readonly [string, string, number])[] = [',
);
for (const [prop, name, kind] of rows) {
	tsLines.push(`\t[${ts(prop)}, ${ts(name)}, ${KIND_NAMES[kind]}],`);
}
tsLines.push(
	'];',
	'',
	'/** Style properties that take no `px` suffix for numbers (sorted). */',
	'export const UNITLESS: readonly string[] = [',
);
for (const name of unitless) {
	tsLines.push(`\t${ts(name)},`);
}
tsLines.push(
	'];',
	'',
	'/** HTML void elements as React knows them (sorted). */',
	'export const VOID_ELEMENTS: readonly string[] = [',
);
for (const name of voidElements) {
	tsLines.push(`\t${ts(name)},`);
}
tsLines.push('];', '');
mkdirSync(path.join(root, 'packages', 'kamado', 'src', 'jsx'), { recursive: true });
writeFileSync(
	path.join(root, 'packages', 'kamado', 'src', 'jsx', 'attr-table.ts'),
	tsLines.join('\n'),
);

/**
 * Quotes a string for Rust.
 * @param {string} value - The string
 * @returns {string} A double-quoted literal
 */
function rs(value) {
	return JSON.stringify(value);
}

const rsLines = [];
for (const line of banner.split('\n')) {
	rsLines.push(`//! ${line}`);
}
rsLines.push(
	'//!',
	'//! The attribute table React DOM applies to host element props, as far as it',
	'//! differs from "write the name as is".',
	'',
	'/// Written as `name="escaped value"`; function, symbol and boolean values are dropped.',
	'pub const STRING: u8 = 0;',
	'/// Truthy value writes `name=""`, falsy / function / symbol writes nothing.',
	'pub const BOOLEAN: u8 = 1;',
	'/// `true` writes `name=""`, `false` writes nothing, anything else is a string.',
	'pub const OVERLOADED_BOOLEAN: u8 = 2;',
	'/// Dropped when the value is not a number (`isNaN`), otherwise a string.',
	'pub const NUMERIC: u8 = 3;',
	'/// Like [`NUMERIC`] and additionally dropped below 1.',
	'pub const POSITIVE_NUMERIC: u8 = 4;',
	'/// A string even for booleans (`contentEditable="true"`).',
	'pub const BOOLEANISH_STRING: u8 = 5;',
	'/// Never written (`defaultValue`, `ref`, `suppressHydrationWarning`, ...).',
	'pub const RESERVED: u8 = 6;',
	'/// `src` / `href`: sanitised (`javascript:` URLs are rewritten), an empty string, function, symbol',
	'/// and boolean are dropped. (React has no such "kind"; it is a separate branch of its switch.)',
	'pub const URL_ATTR: u8 = 7;',
	'/// `action`, `formAction`, `xlinkHref`: like [`URL_ATTR`] but an empty string is kept.',
	'pub const URL_ATTR_KEEP_EMPTY: u8 = 8;',
	'/// `style`: an object of CSS declarations (see the runtime), a string throws.',
	'pub const STYLE: u8 = 9;',
	'',
	'/// `(React prop name, HTML attribute name as React writes it, kind)`, sorted by prop name in byte order.',
	'///',
	'/// Props React writes unchanged as plain strings (`id`, `title`, `alt`, `lang`, ...) are not in the',
	'/// table: [`lookup`] returning `None` means "write the name as is, kind [`STRING`]". Further rules',
	'/// that are not table entries:',
	'///',

	'/// - `aria-*` and `data-*` props are written as is; unlike other [`STRING`] props their boolean',
	'///   values are written (`aria-hidden="true"`), i.e. they behave like [`BOOLEANISH_STRING`].',
	'/// - A name starting with `on` (any case, longer than two characters) that is not in the table is an',
	'///   event handler and is dropped, as is a name that is not a valid attribute name.',
	'/// - `key`, `children` and `dangerouslySetInnerHTML` are consumed by the element, not written.',
	'/// - Custom elements (a `-` in the tag name) skip this table entirely and write names as is.',
	`pub static PROPS: [(&str, &str, u8); ${rows.length}] = [`,
);
for (const [prop, name, kind] of rows) {
	rsLines.push(`    (${rs(prop)}, ${rs(name)}, ${KIND_NAMES[kind]}),`);
}
rsLines.push(
	'];',
	'',
	'/// Binary search in [`PROPS`]: `Some((attribute name, kind))`.',
	"pub fn lookup(prop: &str) -> Option<(&'static str, u8)> {",
	'    PROPS',
	'        .binary_search_by(|entry| entry.0.cmp(prop))',
	'        .ok()',
	'        .map(|index| (PROPS[index].1, PROPS[index].2))',
	'}',
	'',
	'/// Style properties that take no `px` suffix for numbers (sorted).',
	`pub static UNITLESS: [&str; ${unitless.length}] = [`,
);
for (const name of unitless) {
	rsLines.push(`    ${rs(name)},`);
}
rsLines.push(
	'];',
	'',
	'/// Whether a numeric style value of this property is written without `px`.',
	'pub fn is_unitless(prop: &str) -> bool {',
	'    UNITLESS.binary_search(&prop).is_ok()',
	'}',
	'',
	'/// HTML void elements as React knows them (sorted).',
	`pub static VOID_ELEMENTS: [&str; ${voidElements.length}] = [`,
);
for (const name of voidElements) {
	rsLines.push(`    ${rs(name)},`);
}
rsLines.push(
	'];',
	'',
	'/// Whether React renders this tag as `<tag/>` without an end tag.',
	'pub fn is_void_element(tag: &str) -> bool {',
	'    VOID_ELEMENTS.binary_search(&tag).is_ok()',
	'}',
	'',
);
writeFileSync(
	path.join(root, 'crates', 'kd_js', 'src', 'react_attrs.rs'),
	rsLines.join('\n'),
);
