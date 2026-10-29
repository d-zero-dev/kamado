/* eslint-disable @typescript-eslint/no-unused-vars, unicorn/prefer-single-call, no-console, unicorn/no-lonely-if -- a migration helper to be read and changed per project, not a library */
/**
 * A first pass of Pug to TSX for a migration to kamado v3 (docs/v3/MIGRATION.md).
 *
 * ```sh
 * node scripts/pug-to-tsx.mjs <project> <out> [libs dir, default <project>/__assets/_libs] [--pretty] [--pages=<dir>] [--skip=<text>]...
 * ```
 *
 * `--pretty` writes out the white space that Pug's `pretty` puts between tags
 * (a line break before a tag that is not inline and before the closing tag of
 * one with a block inside). Most of those lines are redundant:
 * `scripts/prune-jsx-newlines.mjs` removes the ones that do not change the output.
 *
 * `extends` / `block` become a layout component with a `slots` prop (`block append` /
 * `prepend` are not converted). Pages are written in the order of the template
 * (`<html static>`). `--pages=<dir>` names the directory (default `htdocs`) whose files
 * are pages: a failure there fails the run, and a page without `<html>` is a fragment
 * (`kdStatic`). `--skip=<text>` leaves out the files whose path contains the text
 * (repeatable).
 *
 * Converts every `.pug` under `<project>/__assets` to a component (`.tsx`, same
 * paths under `<out>/__assets`). `include` becomes a component that receives the
 * props of the file that includes it and the variables in scope; `each` and `if` become
 * `map` (over `_eachOf()`, which loops over an array by index and over an object by
 * key as Pug does, and is written in the file that needs it) and `&&` / `?:`; `pkg.production.*` becomes `site.*` and `filters.date`
 * `formatDate`; comments and the doctype are dropped. What it cannot express it
 * stops on (an unescaped value that is not the only child, `&attributes`):
 * fix the source or the output by hand. It needs the pug packages of the project
 * (`pug-lexer`, `pug-parser`, `acorn`) and a build of kamado.
 *
 * The output is written to pass the type check of `@d-zero/tsconfig` (strictest) with
 * `@types/react`: the attributes are spelt as React spells them (`dateTime`, `srcSet`),
 * the parameters of the arrow functions of the Pug code are typed `any`, an import that
 * nothing uses is left out, and `<out>/__assets/kamado-jsx.d.ts` declares what the types
 * of React lack (`static` of `<html static>`, `command`, `commandfor`). The helpers that
 * do this are in `pug-to-tsx-types.mjs`.
 *
 * An attribute name that the runtime does not write (`@click`, an emoji) is printed as
 * `warning: <file>: ...` after the count of files; the page would lose the attribute.
 *
 * A sidecar `.json` (a JSON with a page of its name, `.pug` `.html` `.tsx` or `.jsx`, next to
 * it) and the front matter of an `.html` under `<project>/__assets` that name a
 * `.pug` in `layout` are written to `<out>` with the name as a layout has it (no extension),
 * and printed as `layout rewritten: <file>`; the files in the project are not touched. A
 * `warning:` follows a name that no converted file ends with (the copy is written), and a `.json`
 * that is not valid JSON or has no string for `layout` at the top level (no copy is written).
 *
 * Read the output before using it: the names of the data variables
 * (`data`, `blocks`) follow the files of the data directory (see MIGRATION.md 3.4).
 */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
	blockText,
	booleanCondition,
	isIdentifierUsed,
	jsxDeclarations,
	literalKeys,
	omittedBranchesToUndefined,
	orderImports,
	pruneUnusedImports,
	typedExpression,
	typedProgram,
} from './pug-to-tsx-types.mjs';

const [srcRoot, outRoot, libsArg] = process.argv
	.slice(2)
	.filter((a) => !a.startsWith('--'));
const flagValues = (name) =>
	process.argv
		.filter((a) => a.startsWith(`--${name}=`))
		.map((a) => a.slice(name.length + 3));
const PAGES_DIR = flagValues('pages').at(-1) ?? 'htdocs';
const SKIPS = flagValues('skip');
const inPages = (file) => file.includes(`${path.sep}${PAGES_DIR}${path.sep}`);
if (!srcRoot || !outRoot) {
	console.error('usage: node scripts/pug-to-tsx.mjs <project> <out> [libs dir]');
	process.exit(1);
}
const require = createRequire(path.join(path.resolve(srcRoot), 'package.json'));
const acorn = require('acorn');
// The acorn that Pug pulls in (through is-expression) is 7, which reads `ecmaVersion:
// 'latest'` as ES5 and fails on the code of today with a bare syntax error.
if (Number.parseInt(acorn.version, 10) < 8) {
	console.error(
		`acorn ${acorn.version} is too old: the converter needs acorn 8 or later in ${srcRoot} (add it to its devDependencies)`,
	);
	process.exit(1);
}
const lex = require('pug-lexer');
const parse = require('pug-parser');
const libs = libsArg ?? path.join(srcRoot, '__assets', '_libs');
const VOID = new Set(
	'area base br col embed hr img input link meta param source track wbr'.split(' '),
);
// html attribute name (lower case) -> React prop name
const { REACT_PROP_NAMES } = await import('./react-prop-names.mjs');
const { ELEMENT_BOOLEAN_PROPS, PROPS } = await import(
	new URL('../packages/kamado/dist/jsx/attr-table.js', import.meta.url).href
);
if (ELEMENT_BOOLEAN_PROPS === undefined) {
	console.error(
		'packages/kamado/dist is older than the table of attributes (no ELEMENT_BOOLEAN_PROPS): run `yarn build`',
	);
	process.exit(1);
}
const { el } = await import(
	new URL('../packages/kamado/dist/jsx/runtime.js', import.meta.url).href
);
// Whether the runtime writes an attribute of that name. It does not for a name that is not
// an XML Name (`@click`, `[x]`, an emoji), as React does not: asking it keeps this
// from copying its rule.
const writableNames = new Map();
const isWritableName = (name) => {
	if (!writableNames.has(name)) {
		writableNames.set(name, String(el('i', { [name]: '' })) !== '<i></i>');
	}
	return writableNames.get(name);
};
// What `each` loops over in Pug: a value with a numeric `length` by index, any other by key
// (`for in`, as Pug compiles it). It is written in each file that has an `each`, so that the
// output needs nothing of kamado for it.
const EACH_OF = `function _eachOf(source: any): [any, any][] {
	const entries: [any, any][] = [];
	if (typeof source.length === 'number') {
		for (let index = 0; index < source.length; index++) entries.push([source[index], index]);
	} else {
		for (const key in source) entries.push([source[key], key]);
	}
	return entries;
}`;
// A name JSX takes as it is: an identifier, with `-`, and one `:` between two such parts
// (`xlink:href`). `:foo`, `x.y`, `$a` (JSX takes it, an XML Name does not), `@click`, `[x]`
// and an emoji are written in a spread.
const JSX_ATTRIBUTE_NAME = /^[A-Z_][\w-]*(?::[A-Z_][\w-]*)?$/i;
// What the converter leaves to the reader, printed after the count of files.
const warnings = new Set();
// Props React spells in camel case that its own table does not list.
const propOf = new Map([
	['charset', 'charSet'],
	['itemprop', 'itemProp'],
	['itemtype', 'itemType'],
	['itemid', 'itemID'],
	['itemref', 'itemRef'],
]);
const kindOf = new Map();
for (const [prop, attr, kind] of PROPS) {
	propOf.set(attr.toLowerCase(), prop);
	propOf.set(prop.toLowerCase(), prop);
	kindOf.set(prop, kind);
}
// `tag:prop` of the boolean props that only one element writes (`option:selected`).
const elementBooleans = new Set(
	ELEMENT_BOOLEAN_PROPS.map(([tag, prop]) => `${tag}:${prop}`),
);
// The types of `@types/react` know only the React spelling (`dateTime`, `srcSet`), which
// the table of the runtime has no entry for (React writes them as they are). Names of
// React 19 that `possibleStandardNames` lacks are added by hand after them.
for (const [attr, prop] of [
	...REACT_PROP_NAMES,
	['popovertarget', 'popoverTarget'],
	['popovertargetaction', 'popoverTargetAction'],
]) {
	if (!propOf.has(attr)) propOf.set(attr, prop);
}
// The props that @types/react types as `number` and nothing else (a string is an error).
const NUMBER_PROPS = new Set(
	'tabIndex cols colSpan high low optimum maxLength minLength rows rowSpan size span start border marginHeight marginWidth'.split(
		' ',
	),
);
// The HTML props that React writes as the words "true" and "false" (the table calls them
// booleanish strings): Pug writes a true as an empty attribute and leaves a false out.
// `value` and the SVG props of that kind take other values as well, so they are not here.
const ENUMERATED_BOOLEAN_PROPS = new Set(['contentEditable', 'draggable', 'spellCheck']);
const GLOBALS = new Set([
	'props',
	'undefined',
	'null',
	'true',
	'false',
	'Math',
	'JSON',
	'Object',
	'Array',
	'String',
	'Number',
	'Date',
	'console',
	'NaN',
	'Infinity',
	'Boolean',
	'Symbol',
	'BigInt',
	'RegExp',
	'Error',
	'Map',
	'Set',
	'Intl',
	'parseInt',
	'parseFloat',
	'isNaN',
	'isFinite',
	'encodeURIComponent',
	'decodeURIComponent',
	'encodeURI',
	'decodeURI',
]);
// names every component gets from props
const PROP_NAMES = new Set([
	'page',
	'site',
	'breadcrumbs',
	'titleList',
	'formatDate',
	'content',
	'pages',
	'nav',
	'meta',
]);
// The names of the data files (without the extension) are variables in Pug and keys of `data`.
const DATA_VARS = new Set(['data', 'blocks']);
try {
	for (const f of readdirSync(path.join(libs, 'data'))) {
		const key = f.replace(/\.[^.]+$/, '');
		if (/^[A-Z_$][\w$]*$/i.test(key) && !f.startsWith('.')) DATA_VARS.add(key);
	}
} catch {
	// a project without a data directory
}

/**
 *
 * @param expr
 * @param declared
 */
function free(expr, declared) {
	let ast;
	try {
		ast = acorn.parseExpressionAt(`(${expr})`, 0, { ecmaVersion: 'latest' });
	} catch (error) {
		throw new Error(`cannot parse expression: ${expr}: ${error.message}`);
	}
	const names = new Set();
	walkFree(ast, new Set(declared), names);
	return names;
}

/**
 * The free variables of a statement (an `if`, a loop, a block): what it reads
 * and does not declare itself.
 * @param node A statement of an acorn program
 * @param declared Names that are known
 */
function freeStatement(node, declared) {
	const names = new Set();
	walkFree(node, new Set(declared), names);
	return names;
}

/**
 * The names a node assigns to (`x = 1`, `x += 1`, `x++`).
 * @param node
 * @param out
 */
function assignedNames(node, out = new Set()) {
	if (!node || typeof node.type !== 'string') return out;
	if (node.type === 'AssignmentExpression') {
		// `x = 1`, and `[a, b] = [b, a]` / `({ a } = o)`: the names of the target.
		for (const n of bindingNames(node.left)) out.add(n);
	}
	if ((node.type === 'ForInStatement' || node.type === 'ForOfStatement') && node.left) {
		// `for (x of list)`: a declaration (`for (const x ...)`) has none to give.
		for (const n of bindingNames(node.left)) out.add(n);
	}
	if (node.type === 'UpdateExpression' && node.argument.type === 'Identifier') {
		out.add(node.argument.name);
	}
	for (const key of Object.keys(node)) {
		const v = node[key];
		if (Array.isArray(v)) for (const c of v) assignedNames(c, out);
		else if (v && typeof v.type === 'string') assignedNames(v, out);
	}
	return out;
}

/**
 * Collects into `names` the identifiers below `node` that `scope` does not hold.
 * @param node
 * @param scope A set of names, which declarations in the node add to
 * @param names
 */
function walkFree(node, scope, names) {
	if (!node || typeof node.type !== 'string') return;
	switch (node.type) {
		case 'Identifier': {
			if (!scope.has(node.name)) names.add(node.name);
			return;
		}
		case 'MemberExpression': {
			walkFree(node.object, scope, names);
			if (node.computed) walkFree(node.property, scope, names);
			return;
		}
		case 'Property': {
			if (node.computed) walkFree(node.key, scope, names);
			walkFree(node.value, scope, names);
			return;
		}
		case 'VariableDeclaration': {
			for (const d of node.declarations) for (const n of bindingNames(d.id)) scope.add(n);
			for (const d of node.declarations) walkFree(d.init, scope, names);
			return;
		}
		case 'FunctionDeclaration':
		case 'ArrowFunctionExpression':
		case 'FunctionExpression': {
			if (node.type === 'FunctionDeclaration' && node.id) scope.add(node.id.name);
			const inner = new Set(scope);
			for (const p of node.params) for (const n of bindingNames(p)) inner.add(n);
			walkFree(node.body, inner, names);
			return;
		}
		case 'BlockStatement':
		case 'ForStatement':
		case 'ForOfStatement':
		case 'ForInStatement': {
			// A declaration inside belongs to the block.
			const inner = new Set(scope);
			for (const key of Object.keys(node)) {
				const v = node[key];
				if (Array.isArray(v)) for (const c of v) walkFree(c, inner, names);
				else if (v && typeof v.type === 'string') walkFree(v, inner, names);
			}
			return;
		}
		default: {
			for (const key of Object.keys(node)) {
				const v = node[key];
				if (Array.isArray(v)) for (const c of v) walkFree(c, scope, names);
				else if (v && typeof v.type === 'string') walkFree(v, scope, names);
			}
		}
	}
}

/**
 *
 * @param expr
 */
function mapExpr(expr) {
	return (
		expr
			.replaceAll(/(?<![.\w$])block(?![\w$])/g, 'props.children')
			// `locals[...]` reads a data file by a name that is not an identifier.
			.replaceAll(/(?<![.\w$])locals(?=\[)/g, 'props.data')
			.replaceAll(/\bpkg\.production\./g, 'site.')
			.replaceAll(/\bfilters\.date\(/g, 'formatDate(')
	);
}

const converted = new Map();
// JSX drops the line breaks and the indentation of a text, which a `pre` and a
// `textarea` must keep. A mixin or an include called inside of one is therefore a second
// component, named with `Pre` at the end, whose text is written as strings; the plain one
// stays for the calls outside. Only the calls tell which are needed, so the file of each
// is converted once more when the calls are all seen.
// file -> the names of its mixins, and `*` for what the file writes besides them.
const preNeeds = new Map();
const PRE_BODY = '*';
/**
 * Records that something of a file is called inside of a `pre`.
 * @param file the Pug file that defines the mixin or is included
 * @param key the name of the mixin, or `PRE_BODY` for the markup the file writes itself
 */
function requestPre(file, key) {
	const keys = preNeeds.get(file) ?? new Set();
	keys.add(key);
	preNeeds.set(file, keys);
}
/**
 * Imports the component for a call in a `pre` from the module that writes it.
 * @param ctx the context of the calling file
 * @param spec the module the component is imported from
 * @param name the name of the component (ending with `Pre`)
 */
function importPre(ctx, spec, name) {
	const names = ctx.named.get(spec) ?? [];
	if (!names.includes(name)) ctx.named.set(spec, [...names, name]);
}
// `--pretty`: write out the white space that Pug's `pretty` option puts into pages.
const PRETTY = process.argv.includes('--pretty');
const PUG_INLINE = new Set([
	'a',
	'abbr',
	'acronym',
	'b',
	'br',
	'code',
	'em',
	'font',
	'i',
	'img',
	'ins',
	'kbd',
	'map',
	'samp',
	'small',
	'span',
	'strong',
	'sub',
	'sup',
]);

/**
 * Whether the expression is one string literal (and not `"a" + b`).
 * @param source
 */
function isStringLiteral(source) {
	try {
		const node = acorn.parseExpressionAt(source, 0, { ecmaVersion: 'latest' });
		return (
			node.type === 'Literal' &&
			typeof node.value === 'string' &&
			node.end === source.length
		);
	} catch {
		return false;
	}
}

/**
 * Whether the code only declares (`const`, `let`, `var`, `function`).
 * @param code
 */
function declaresOnly(code) {
	try {
		const program = acorn.parse(mapExpr(code), { ecmaVersion: 'latest' });
		return program.body.every(
			(n) => n.type === 'VariableDeclaration' || n.type === 'FunctionDeclaration',
		);
	} catch {
		return false;
	}
}

/**
 * pug-code-gen's `tagCanInline`: only text without a line break and inline tags inside.
 * @param nodes
 */
function canInline(nodes) {
	return nodes.every(
		(k) =>
			(k.type === 'Text' && !/\n/.test(k.val)) ||
			// `time= x` on one line is inline; `= x` on a line of its own is not.
			(k.type === 'Code' && k.isInline === true) ||
			(k.type === 'Tag' && PUG_INLINE.has(k.name)),
	);
}
const queue = [];

/**
 *
 * @param file
 */
function pascal(file) {
	return path
		.basename(file, '.pug')
		.split(/[-_.]/)
		.filter(Boolean)
		.map((s) => s[0].toUpperCase() + s.slice(1))
		.join('')
		.replace(/^(\d)/, 'Page$1');
}

/**
 *
 * @param text
 */
function jsxText(text) {
	if (/</.test(text)) throw new Error(`raw HTML in text is not supported: ${text}`);
	// An entity (`&nbsp;`) is what Pug passed on as it was, and JSX reads it the same way.
	const bare = text.replaceAll(/&(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);/g, '');
	if (/[{}]/.test(text) || /&/.test(bare)) return `{${JSON.stringify(text)}}`;
	// A `>` in JSX text is a syntax error of TypeScript: the entity reads as the same text.
	return text.replaceAll('>', '&gt;');
}

/**
 *
 * @param file
 */
/**
 * A mixin's name as a component's: JSX takes a lower case name for an element.
 * @param name
 */
function component(name) {
	// `c-header` is `CHeader`.
	return name
		.split(/[-_]/)
		.map((s) => (s ? s[0].toUpperCase() + s.slice(1) : s))
		.join('');
}

/**
 *
 * @param file
 */
function newContext(file) {
	return {
		file,
		declared: new Set(),
		used: new Set(),
		imports: new Map(),
		rt: new Set(),
		assigned: new Set(),
		usesEach: false,
		shadowed: new Set(),
		named: new Map(),
		mixins: new Map(),
		scope: [],
		nesting: 0,
		hoisted: [],
	};
}

/**
 * The parameters of a mixin: `a, b = "x"` -> [{ name, init }].
 * @param args
 */
function mixinParams(args) {
	if (!args || !args.trim()) return [];
	const source = `(${args}) => 0`;
	const ast = acorn.parseExpressionAt(source, 0, { ecmaVersion: 'latest' });
	return ast.params.map((p) => {
		const target = p.type === 'AssignmentPattern' ? p.left : p;
		if (target.type === 'ObjectPattern') {
			// `{ lang = "ja" } = {}`: the call passes an object whose keys are props.
			return {
				name: undefined,
				pattern: source.slice(target.start, target.end),
				names: patternNames(target),
				units: patternUnits(target, source),
			};
		}
		return p.type === 'AssignmentPattern'
			? { name: p.left.name, init: source.slice(p.right.start, p.right.end) }
			: { name: p.name };
	});
}

/**
 * The names an object pattern declares.
 * @param pattern
 */
function patternNames(pattern) {
	return bindingNames(pattern);
}

/**
 * The keyword of a declaration: `let` if the body assigns to any of the names.
 * @param isLet
 * @param names
 */
function declKind(isLet, names) {
	return names.some((n) => isLet(n)) ? 'let' : 'const';
}

/**
 * The pieces of an object pattern that can be declared apart: `{ a = 1, b: { c, d } }` is
 * `a = 1`, `b: { c }` and `b: { d }`, so that the body's assignment to one name does not
 * make `let` of the others (`prefer-const` refuses them, and `--fix` cannot split them).
 * What cannot be cut (a level with a rest, which takes what the other properties leave; a
 * computed key, which would run again for each piece; an array pattern; a pattern with a
 * default) stays one piece, see {@link patternUnit}.
 * @param pattern
 * @param source - The code that the nodes' positions are from.
 * @param wrap - Puts the text of a piece into the patterns around it.
 * @returns The pieces in the order of the pattern: `build(isLet, taken)` gives the keyword,
 * the code, and the declarations that follow it.
 */
function patternUnits(pattern, source, wrap = (text) => text) {
	const rest = pattern.properties.find((p) => p.type === 'RestElement');
	if (rest) {
		const first = pattern.properties[0];
		return [patternUnit(source, first.start, rest.end, wrap, (walk) => walk(pattern))];
	}
	return pattern.properties.flatMap((p) => {
		if (
			p.value.type === 'ObjectPattern' &&
			!p.computed &&
			p.value.properties.length > 0
		) {
			const key = source.slice(p.start, p.value.start);
			return patternUnits(p.value, source, (text) => wrap(`${key}{ ${text} }`));
		}
		return [patternUnit(source, p.start, p.end, wrap, (walk) => walk(p))];
	});
}

/**
 * One piece of a pattern, and how to declare it. When the body assigns to some of its names but
 * not to all, it is declared with `const` and those names are renamed in it (`id: _id`) and
 * declared after it (`let id = _id;`). A default that reads a renamed name reads the new
 * name, which is the value that the original read too: the body has not run yet.
 * @param source
 * @param start - Where the text of the piece starts in the source.
 * @param end
 * @param wrap
 * @param visit - Calls `walk` with the node that holds the bindings.
 */
function patternUnit(source, start, end, wrap, visit) {
	const bindings = [];
	const expressions = [];
	const walk = (node, shorthand = false) => {
		switch (node.type) {
			case 'Identifier': {
				bindings.push({ name: node.name, start: node.start, end: node.end, shorthand });
				break;
			}
			case 'Property': {
				if (node.computed) expressions.push(node.key);
				walk(node.value, node.shorthand);
				break;
			}
			case 'ObjectPattern': {
				for (const p of node.properties) walk(p);
				break;
			}
			case 'ArrayPattern': {
				for (const element of node.elements) if (element) walk(element);
				break;
			}
			case 'AssignmentPattern': {
				walk(node.left, shorthand);
				expressions.push(node.right);
				break;
			}
			case 'RestElement': {
				walk(node.argument);
				break;
			}
		}
	};
	visit(walk);
	const names = bindings.map((b) => b.name);
	return {
		build: (isLet, taken) => {
			const letNames = names.filter((n) => isLet(n));
			const code = source.slice(start, end);
			if (letNames.length === 0 || letNames.length === names.length) {
				return { kind: declKind(isLet, names), text: wrap(code), after: [] };
			}
			const alias = new Map();
			for (const name of new Set(letNames)) {
				let to = `_${name}`;
				while (taken.has(to)) to += '_';
				taken.add(to);
				alias.set(name, to);
			}
			const edits = [];
			for (const b of bindings) {
				const to = alias.get(b.name);
				if (to)
					edits.push({
						start: b.start,
						end: b.end,
						text: b.shorthand ? `${b.name}: ${to}` : to,
					});
			}
			let readsInFunction = false;
			for (const expression of expressions) {
				readsInFunction ||= renameReads(expression, alias, edits);
			}
			// A function in a default may declare the name again: leave it as it is then.
			if (readsInFunction) return { kind: 'let', text: wrap(code), after: [] };
			let text = code;
			for (const e of edits.toSorted((a, b) => b.start - a.start)) {
				text = text.slice(0, e.start - start) + e.text + text.slice(e.end - start);
			}
			return {
				kind: 'const',
				text: wrap(text),
				after: [...alias].map(([name, to]) => `let ${name} = ${to};`),
			};
		},
	};
}

/**
 * Adds an edit for each read of a name that is renamed, in an expression.
 * @param expression
 * @param alias - The new name for each name.
 * @param edits - Where the edits go.
 * @returns Whether a function that may declare a name again was met (a block body, or a
 * parameter of that name): this does not follow the scopes, so the caller leaves the names.
 */
function renameReads(expression, alias, edits) {
	let inFunction = false;
	const declares = (param) => bindingNames(param).some((n) => alias.has(n));
	const visit = (node, parent, key) => {
		if (!node || typeof node.type !== 'string') return;
		if (/Function/.test(node.type)) {
			// A block may declare the name again, and so may a parameter.
			if (node.body.type === 'BlockStatement' || node.params.some((p) => declares(p))) {
				inFunction = true;
			}
		}
		if (node.type === 'Identifier') {
			const to = alias.get(node.name);
			const isName =
				(parent?.type === 'Property' && key === 'key' && !parent.computed) ||
				(parent?.type === 'MemberExpression' && key === 'property' && !parent.computed);
			if (to && !isName) {
				const shorthand = parent?.type === 'Property' && parent.shorthand;
				edits.push({
					start: node.start,
					end: node.end,
					text: shorthand ? `${node.name}: ${to}` : to,
				});
			}
			return;
		}
		for (const [k, value] of Object.entries(node)) {
			// A shorthand property is one name that the key and the value both point to.
			if (node.type === 'Property' && node.shorthand && k === 'key') continue;
			if (Array.isArray(value)) for (const v of value) visit(v, node, k);
			else if (value && typeof value === 'object') visit(value, node, k);
		}
	};
	visit(expression, undefined, '');
	return inFunction;
}

/**
 * The code of one component: the function (the imports are written by the caller).
 * @param ctx
 * @param name
 * @param body
 * @param exported
 * @param params
 */
function componentText(ctx, name, body, exported, params) {
	const needsExt = [...ctx.used].filter((n) => !ctx.declared.has(n) && !GLOBALS.has(n));
	const fromProps = needsExt.filter((n) => PROP_NAMES.has(n) && n !== 'meta');
	const dataVars = needsExt.filter((n) => DATA_VARS.has(n));
	const external = needsExt.filter((n) => !PROP_NAMES.has(n) && !DATA_VARS.has(n));
	const lines = [''];
	// The body may assign to an argument (`- options = options || {}`): a `let` then.
	const isLet = (name) => ctx.assigned.has(name);
	// What a name that a piece renames must not be.
	const taken = new Set([
		...ctx.used,
		...ctx.declared,
		...needsExt,
		...params.flatMap((p) => p.names ?? [p.name]),
		'props',
		'_data',
		'_vars',
	]);
	// Only the names that it assigns to are `let` (`prefer-const` refuses the others in the
	// same declaration, and `--fix` cannot split it): one declaration for each run of the
	// same keyword, in the order of the names, as a default may read a name before it.
	const declare = (entries, source) => {
		const out = [];
		let run;
		for (const entry of entries) {
			const { kind, text, after } = entry.build(isLet, taken);
			if (run?.kind === kind && after.length === 0) run.texts.push(text);
			else {
				run = { kind, texts: [text] };
				out.push(run);
			}
			// What follows reads the declaration above: the next piece starts a new one.
			if (after.length > 0) {
				out.push(...after.map((line) => ({ line })));
				run = undefined;
			}
		}
		return out.map((o) =>
			o.line ? `\t${o.line}` : `\t${o.kind} { ${o.texts.join(', ')} } = ${source};`,
		);
	};
	const plainUnit = (name, text) => ({
		build: () => ({ kind: declKind(isLet, [name]), text, after: [] }),
	});
	lines.push(
		...declare(
			params.flatMap((p) =>
				p.pattern
					? p.units
					: [plainUnit(p.name, p.init ? `${p.name} = ${p.init}` : p.name)],
			),
			'props as any',
		),
	);
	if (fromProps.length > 0)
		lines.push(`\tconst { ${fromProps.join(', ')} } = props as any;`);
	if (dataVars.length > 0) {
		lines.push('\tconst _data = (props as any).data;');
		for (const v of dataVars) lines.push(`\tconst ${v} = _data.${v};`);
	}
	if (external.length > 0) {
		// The spread of an `any` is an `any`: a cast to it is an error of
		// `no-unnecessary-type-assertion`.
		lines.push('\tconst _vars = { ...(props as any).meta, ...props };');
		lines.push(
			...declare(
				external.map((name) => plainUnit(name, name)),
				'_vars',
			),
		);
	}
	for (const h of ctx.hoisted) lines.push(`\t${h}`);
	lines.push(`\treturn (\n${body}\n\t);`);
	lines.push('}');
	// A parameter that is not read is an error of `noUnusedParameters`: its name starts
	// with an underscore then, which that option leaves alone.
	const reads = isIdentifierUsed(lines.join('\n'), 'props');
	lines[0] = `${exported} function ${name}(${reads ? '' : '_'}props: PageProps & Record<string, any>) {`;
	return lines.join('\n');
}

/**
 *
 * @param ctx
 * @param {...any} contexts
 */
function importLines(...contexts) {
	// One line for each module, whatever the number of components in the file.
	const rt = new Set();
	const imports = new Map();
	const named = new Map();
	for (const ctx of contexts) {
		for (const n of ctx.rt) rt.add(n);
		for (const [name, spec] of ctx.imports) imports.set(name, spec);
		for (const [spec, names] of ctx.named) {
			const set = named.get(spec) ?? new Set();
			for (const n of names) set.add(n);
			named.set(spec, set);
		}
	}
	const entries = [];
	if (rt.size > 0) {
		entries.push({
			spec: 'kamado/jsx',
			line: `import { ${[...rt].join(', ')} } from 'kamado/jsx';`,
		});
	}
	for (const [name, spec] of imports)
		entries.push({ spec, line: `import ${name} from '${spec}';` });
	for (const [spec, names] of named)
		entries.push({ spec, line: `import { ${[...names].join(', ')} } from '${spec}';` });
	// The package ships no props types: the page props are declared where they are used,
	// after the imports (a declaration before them is an error of `import-x/order`).
	const head = orderImports(entries);
	if (head.length > 0) head.push('');
	head.push('type PageProps = Record<string, any>;');
	if (contexts.some((ctx) => ctx.usesEach)) head.push('', EACH_OF);
	return head;
}

/**
 *
 * @param file
 */
function convertFile(file) {
	if (converted.has(file)) return converted.get(file);
	const info = { mixins: [] };
	converted.set(file, info);
	// What a call in a `pre` has asked of this file so far: a call met while converting
	// it asks again, and the file is converted once more (see `preNeeds`).
	const wantsPre = new Set(preNeeds.get(file));
	const src = readFileSync(file, 'utf8');
	const ast = parse(lex(src, { filename: file }), { filename: file, src });
	const rel = path.relative(path.join(srcRoot, '__assets'), file);
	const outFile = path.join(outRoot, '__assets', rel.replace(/\.pug$/, '.tsx'));
	const defs = ast.nodes.filter((n) => n.type === 'Mixin' && !n.call);
	const extended = ast.nodes.find((n) => n.type === 'Extends');
	let text;
	if (extended) {
		text = convertChild(file, ast, extended);
	} else if (defs.length > 0) {
		// A file of mixins: one exported component per mixin.
		const contexts = [];
		const parts = [];
		// A mixin of the file may call another one of it, whichever comes first.
		const sameFile = new Map();
		for (const def of defs) {
			sameFile.set(component(def.name), {
				name: component(def.name),
				params: mixinParams(def.args),
				file,
			});
		}
		// What the file includes at its top level (other files of mixins) is seen by
		// every mixin of it.
		const top = newContext(file);
		for (const n of ast.nodes) if (n.type === 'Include') node(n, top, 0);
		// What it declares at its top level (`- const X = ...`) is a constant of the
		// module, which every mixin sees. Code that reads what a page passes cannot be
		// one: it is left to the reader.
		const constants = new Set();
		const constantCode = [];
		for (const n of ast.nodes) {
			if (n.type !== 'Code' || n.buffer || !declaresOnly(n.val)) continue;
			const read = newContext(file);
			for (const name of constants) read.declared.add(name);
			const code = useStmt(n.val, read);
			// `props` is a global of the component, and `block` and `locals` are written as
			// reads of it: none of them exists at the top of the module.
			const unknown = [...read.used].filter(
				(u) => !read.declared.has(u) && (!GLOBALS.has(u) || u === 'props'),
			);
			if (unknown.length > 0) {
				warnings.add(
					`${path.relative(srcRoot, file)}: the code at the top of a file of mixins reads ${unknown.join(', ')}, which only a page gives: it is not written; write it by hand`,
				);
				continue;
			}
			const names = [...read.declared].filter((name) => !constants.has(name));
			constantCode.push({ code, names });
			for (const name of names) constants.add(name);
			// What the code needs of the runtime (`html()`, `formatDate()`) is imported.
			contexts.push(read);
		}
		for (const def of defs) {
			const params = mixinParams(def.args);
			info.mixins.push({ name: component(def.name), params, file });
			// The component, and one for a call in a `pre` when there is one.
			const variants = [[component(def.name), 0]];
			if (wantsPre.has(component(def.name)))
				variants.push([`${component(def.name)}Pre`, 1]);
			if (variants.length > 1 && sameFile.has(`${component(def.name)}Pre`)) {
				throw new Error(
					`the mixin ${def.name} is called in a pre, and ${component(def.name)}Pre is a mixin of the file already: write it by hand`,
				);
			}
			for (const [componentName, pre] of variants) {
				const ctx = newContext(file);
				ctx.pre = pre;
				for (const n of constants) ctx.declared.add(n);
				for (const [k, v] of top.mixins) ctx.mixins.set(k, v);
				for (const [k, v] of top.named) ctx.named.set(k, v);
				for (const [k, v] of top.imports) ctx.imports.set(k, v);
				for (const [k, v] of sameFile) ctx.mixins.set(k, v);
				for (const p of params) {
					if (p.pattern) for (const n of p.names) ctx.declared.add(n);
					else ctx.declared.add(p.name);
				}
				const body = block(def.block.nodes, ctx, 1);
				contexts.push(ctx);
				parts.push(componentText(ctx, componentName, body, 'export', params));
				for (const name of constants) {
					if (ctx.assigned.has(name)) {
						warnings.add(
							`${path.relative(srcRoot, file)}: the mixin ${def.name} assigns to ${name}, which the top of the file declares for all of them as a constant: write it by hand`,
						);
					}
				}
			}
		}
		// A constant that no mixin reads is not written at the top of the module (the
		// types would call it unused); the body below declares its own.
		// One that only another constant reads is kept with it.
		const usedConstants = [];
		let reachable = parts.join('\n');
		for (let grew = true; grew;) {
			grew = false;
			for (const constant of constantCode) {
				if (
					!usedConstants.includes(constant) &&
					constant.names.some((name) => isIdentifierUsed(reachable, name))
				) {
					usedConstants.push(constant);
					reachable += `\n${constant.code}`;
					grew = true;
				}
			}
		}
		usedConstants.sort((a, b) => constantCode.indexOf(a) - constantCode.indexOf(b));
		// What the file writes besides its mixins is a component of its own (the
		// default export), which is what including the file shows.
		const rest = ast.nodes.filter(
			(n) =>
				!(n.type === 'Mixin' && !n.call) &&
				!['Include', 'Comment', 'BlockComment'].includes(n.type) &&
				!(n.type === 'Code' && !n.buffer),
		);
		if (rest.length > 0) {
			const variants = [[`${pascal(file)}Body`, 0]];
			if (wantsPre.has(PRE_BODY)) variants.push([`${pascal(file)}BodyPre`, 1]);
			for (const [name, pre] of variants) {
				const ctx = newContext(file);
				ctx.pre = pre;
				for (const [k, v] of top.mixins) ctx.mixins.set(k, v);
				for (const [k, v] of top.named) ctx.named.set(k, v);
				for (const [k, v] of top.imports) ctx.imports.set(k, v);
				for (const [k, v] of sameFile) ctx.mixins.set(k, v);
				const body = block(
					ast.nodes.filter((n) => !(n.type === 'Mixin' && !n.call)),
					ctx,
					1,
				);
				contexts.push(ctx);
				parts.push(componentText(ctx, name, body, pre ? 'export' : 'export default', []));
			}
			info.hasBody = true;
		}
		text = pruneUnusedImports(
			importLines(...contexts).join('\n') +
				'\n\n' +
				usedConstants.map(({ code }) => `${code}\n\n`).join('') +
				parts.join('\n\n') +
				'\n',
		);
	} else {
		const ctx = newContext(file);
		const body = block(ast.nodes, ctx, 1);
		// A page that is a fragment has no `<html static>` to say it is written in
		// the order of the template: its meta says so.
		const fragmentPage =
			inPages(file) && !ast.nodes.some((n) => n.type === 'Tag' && n.name === 'html');
		const contexts = [ctx];
		const parts = [componentText(ctx, pascal(file), body, 'export default', [])];
		// What a `pre` includes of this file is the same text, written as strings.
		if (wantsPre.has(PRE_BODY)) {
			const preCtx = newContext(file);
			preCtx.pre = 1;
			const preBody = block(ast.nodes, preCtx, 1);
			contexts.push(preCtx);
			parts.push(componentText(preCtx, `${pascal(file)}Pre`, preBody, 'export', []));
		}
		text = pruneUnusedImports(
			importLines(...contexts).join('\n') +
				'\n\n' +
				(fragmentPage ? 'export const meta = { kdStatic: true };\n\n' : '') +
				parts.join('\n\n') +
				'\n',
		);
	}
	mkdirSync(path.dirname(outFile), { recursive: true });
	writeFileSync(outFile, text);
	return info;
}

/**
 * A page that `extends` a layout: the layout component receives the code of the
 * `vars` block as props and every other block as an element in `slots`.
 * @param file
 * @param ast
 * @param extended
 */
function convertChild(file, ast, extended) {
	const ctx = newContext(file);
	const wantsPre = new Set(preNeeds.get(file));
	// Pug adds `.pug` to a path without an extension.
	const named = path.extname(extended.file.path)
		? extended.file.path
		: `${extended.file.path}.pug`;
	const parent = named.startsWith('/')
		? path.join(libs, named)
		: path.resolve(path.dirname(file), named);
	convertFile(parent);
	const parentName = pascal(parent);
	const toOut = (f) =>
		path.join(outRoot, '__assets', path.relative(path.join(srcRoot, '__assets'), f));
	let spec = path
		.relative(path.dirname(toOut(file)), toOut(parent))
		.replace(/\.pug$/, '.tsx');
	if (!spec.startsWith('.')) spec = `./${spec}`;
	ctx.imports.set(parentName, spec);

	// Mixins written in the page are components of the same module.
	const defs = ast.nodes.filter((n) => n.type === 'Mixin' && !n.call);
	for (const def of defs) {
		ctx.mixins.set(component(def.name), {
			name: component(def.name),
			params: mixinParams(def.args),
			file,
		});
	}
	const contexts = [ctx];
	const parts = [];
	for (const def of defs) {
		const params = mixinParams(def.args);
		// The component, and one for a call in a `pre` when there is one.
		const variants = [[component(def.name), 0]];
		if (wantsPre.has(component(def.name))) {
			if (defs.some((d) => component(d.name) === `${component(def.name)}Pre`)) {
				throw new Error(
					`the mixin ${def.name} is called in a pre, and ${component(def.name)}Pre is a mixin of the file already: write it by hand`,
				);
			}
			variants.push([`${component(def.name)}Pre`, 1]);
		}
		for (const [componentName, pre] of variants) {
			const mixCtx = newContext(file);
			mixCtx.pre = pre;
			mixCtx.mixins = ctx.mixins;
			for (const p of params) {
				if (p.pattern) for (const n of p.names) mixCtx.declared.add(n);
				else mixCtx.declared.add(p.name);
			}
			const body = block(def.block.nodes, mixCtx, 1);
			contexts.push(mixCtx);
			// Of the two, the one that no call uses would be an unused local of the page.
			const exported = variants.length > 1 ? 'export' : '';
			parts.push(componentText(mixCtx, componentName, body, exported, params).trim());
		}
	}

	const blocks = ast.nodes.filter((n) => n.type === 'NamedBlock');
	for (const b of blocks) {
		if (b.mode && b.mode !== 'replace') {
			// The layout would have to show its own default and then the page's.
			throw new Error(
				`block ${b.mode} ${b.name} in ${file} is not converted: write it by hand`,
			);
		}
	}
	// The page, and one for an include in a `pre` when there is one: the slots of it are
	// the text written as strings (the layout around them stays as it is).
	const pageVariants = [[ctx, pascal(file), 'export default']];
	if (wantsPre.has(PRE_BODY)) {
		if (defs.some((d) => component(d.name) === `${pascal(file)}Pre`)) {
			throw new Error(
				`the file is included in a pre, and ${pascal(file)}Pre is a mixin of the file already: write it by hand`,
			);
		}
		const preCtx = newContext(file);
		preCtx.pre = 1;
		preCtx.imports.set(parentName, spec);
		preCtx.mixins = ctx.mixins;
		contexts.push(preCtx);
		pageVariants.push([preCtx, `${pascal(file)}Pre`, 'export']);
	}
	const pages = pageVariants.map(([pageCtx, name, exported]) => {
		for (const v of blocks.filter((n) => n.name === 'vars'))
			children(v.nodes, pageCtx, 0);
		const given = [...pageCtx.declared];
		const slots = [];
		for (const n of blocks.filter((b) => b.name !== 'vars')) {
			slots.push(
				`\t\t\t${JSON.stringify(n.name)}: (\n${block(n.nodes, pageCtx, 4)}\n\t\t\t)`,
			);
		}
		const body = `\t\t<${parentName} {...props}${given.length > 0 ? ` {...{ ${given.join(', ')} }}` : ''} slots={{\n${slots.join(',\n')},\n\t\t}} />`;
		return componentText(pageCtx, name, body, exported, []);
	});
	// A fragment of slots is evaluated before the layout's `<html static>` is
	// reached, so the page says it is static itself.
	return pruneUnusedImports(
		importLines(...contexts).join('\n') +
			'\n\n' +
			'export const meta = { kdStatic: true };\n\n' +
			parts.join('\n\n') +
			(parts.length > 0 ? '\n\n' : '') +
			pages.join('\n\n') +
			'\n',
	);
}

/**
 *
 * @param n
 */
function indent(n) {
	return '\t'.repeat(n + 1);
}

/**
 *
 * @param expr
 * @param ctx
 */
function use(expr, ctx) {
	const mapped = mapExpr(expr);
	for (const n of free(mapped, [...ctx.declared])) ctx.used.add(n);
	return typedExpression(mapped, acorn);
}

/**
 * Children of a block as JSX lines (a fragment when there is not exactly one).
 * @param nodes
 * @param ctx
 * @param depth
 */
function block(nodes, ctx, depth) {
	const parts = children(nodes, ctx, depth);
	// One element stands for itself; text and expressions need a fragment.
	if (parts.length === 1 && parts[0].trimStart().startsWith('<')) return parts[0];
	return `${indent(depth)}<>\n${parts.join('\n')}\n${indent(depth)}</>`;
}

/**
 *
 * @param nodes
 * @param ctx
 * @param depth
 */
function children(nodes, ctx, depth) {
	const out = [];
	for (let i = 0; i < nodes.length; i++) {
		const n = nodes[i];
		if (n.type === 'Code' && !n.buffer && ctx.nesting === 0 && declaresOnly(n.val)) {
			// A declaration is visible to the rest of the template: it goes to the
			// top. An assignment stays where it is, so that what comes before it
			// sees the old value (`- x = true` ... `- x = false` ...).
			ctx.hoisted.push(useStmt(n.val, ctx));
			continue;
		}
		if (n.type === 'Code' && !n.buffer) {
			// Statements: the rest of the siblings go into a function that sees them.
			const stmts = [];
			let j = i;
			while (j < nodes.length && nodes[j].type === 'Code' && !nodes[j].buffer) {
				stmts.push(nodes[j].val);
				j++;
			}
			// What they declare is known to the rest once they were read.
			const stmtCode = stmts
				.map((s) => `${indent(depth + 1)}${useStmt(s, ctx)}`)
				.join('\n');
			const rest = children(nodes.slice(j), ctx, depth + 2);
			const inner = `${indent(depth + 2)}<>\n${rest.join('\n')}\n${indent(depth + 2)}</>`;
			out.push(
				`${indent(depth)}{(() => {\n${stmtCode}\n${indent(depth + 1)}return (\n${inner}\n${indent(depth + 1)});\n${indent(depth)}})()}`,
			);
			return out;
		}
		const lines = node(n, ctx, depth);
		if (lines.length > 0) out.push(lines.join('\n'));
	}
	return out;
}

/**
 *
 * @param stmt
 * @param ctx
 * @param pattern
 */
function bindingNames(pattern) {
	switch (pattern.type) {
		case 'Identifier': {
			return [pattern.name];
		}
		case 'ObjectPattern': {
			return pattern.properties.flatMap((p) =>
				bindingNames(p.type === 'RestElement' ? p.argument : p.value),
			);
		}
		case 'ArrayPattern': {
			return pattern.elements.filter(Boolean).flatMap((p) => bindingNames(p));
		}
		case 'AssignmentPattern': {
			return bindingNames(pattern.left);
		}
		case 'RestElement': {
			return bindingNames(pattern.argument);
		}
		default: {
			return [];
		}
	}
}

/**
 *
 * @param stmt
 * @param ctx
 */
function useStmt(stmt, ctx) {
	const mapped = mapExpr(stmt);
	let program;
	try {
		program = acorn.parse(mapped, { ecmaVersion: 'latest' });
	} catch (error) {
		throw new Error(`cannot parse statement: ${mapped}: ${error.message}`);
	}
	// The initialisers (and expression statements) are what reads variables; a
	// name declared earlier is not a free one. What this declares is registered
	// here, after its own initialiser was read.
	const local = [...ctx.declared];
	const declare = [];
	const read = (node, own = []) => {
		for (const n of free(mapped.slice(node.start, node.end), local)) {
			// `var title = title || "x"` would take the value a page passes, which a
			// local of the same name hides.
			if (own.includes(n)) {
				throw new Error(
					`${n} is read in the code that declares it (${mapped.slice(0, 80)}): write it by hand`,
				);
			}
			ctx.used.add(n);
		}
	};
	for (const node of program.body) {
		if (node.type === 'VariableDeclaration') {
			for (const d of node.declarations) {
				const names = bindingNames(d.id);
				if (d.init) read(d.init, names);
				for (const n of names) {
					local.push(n);
					ctx.declared.add(n);
				}
			}
		} else if (node.type === 'ExpressionStatement') {
			const e = node.expression;
			if (
				e.type === 'AssignmentExpression' &&
				e.left.type === 'Identifier' &&
				!local.includes(e.left.name)
			) {
				// Pug code may assign a variable it never declared: it becomes a local.
				read(e.right, [e.left.name]);
				declare.push(e.left.name);
				local.push(e.left.name);
				ctx.declared.add(e.left.name);
			} else {
				read(e);
				// `options = options || {}` of a mixin argument: it cannot be a `const`.
				for (const n of assignedNames(e)) ctx.assigned.add(n);
			}
		} else {
			// An `if`, a loop, a function: what it reads and does not declare is free.
			if (node.type === 'FunctionDeclaration' && node.id) {
				local.push(node.id.name);
				ctx.declared.add(node.id.name);
			}
			for (const n of freeStatement(node, local)) ctx.used.add(n);
			for (const n of assignedNames(node)) ctx.assigned.add(n);
		}
	}
	// A variable Pug code assigns is visible to the rest of the template, wherever the
	// assignment is: its `let` goes to the top of the component.
	for (const n of declare) {
		// A prop that the code assigns is a local that starts as the prop, and what
		// an included file or a mixin gets (it would read the prop otherwise).
		if (PROP_NAMES.has(n)) ctx.shadowed.add(n);
		ctx.hoisted.push(
			PROP_NAMES.has(n) ? `let ${n}: any = (props as any).${n};` : `let ${n}: any;`,
		);
	}
	const typedCode = typedProgram(mapped, program);
	return typedCode.endsWith(';') || typedCode.endsWith('}') ? typedCode : `${typedCode};`;
}

/**
 *
 * @param tag
 * @param ctx
 */
function attrsOf(tag, ctx) {
	const classes = [];
	const out = [];
	const spread = [];
	let id;
	if ((tag.attributeBlocks ?? []).length > 0) {
		// `&attributes(obj)` would be left out without a word.
		throw new Error(
			`&attributes of <${tag.name}> in ${ctx.file} is not converted: write it by hand`,
		);
	}
	for (const a of tag.attrs) {
		const name = a.name;
		const val = a.val;
		const isString = typeof val === 'string' && isStringLiteral(val);
		const strValue = isString
			? val.slice(1, -1).replaceAll(/\\(["'\\])/g, '$1')
			: undefined;
		if (name === 'class') {
			if (isString) classes.push(strValue);
			else classes.push({ expr: use(val, ctx) });
			continue;
		}
		if (!JSX_ATTRIBUTE_NAME.test(name)) {
			// A name JSX cannot write: spread an object. The runtime drops the ones that are
			// not an XML Name, so the page loses the attribute without a word at the build.
			if (!isWritableName(name)) {
				warnings.add(
					`${path.relative(srcRoot, ctx.file)}: the attribute ${JSON.stringify(name)} of <${tag.name}> is not written by the runtime (as React does not): write the element with html() or html.inject`,
				);
			}
			spread.push(
				`${JSON.stringify(name)}: ${isString ? JSON.stringify(strValue) : val === true ? '""' : use(val, ctx)}`,
			);
			continue;
		}
		if (/^on[a-z]+$/i.test(name)) {
			// An event handler takes a function in the types, and the string Pug wrote is
			// output only by a static page: spread it, as written, so that it is not typed.
			// It stays where it was written: the order of the attributes is the output's.
			out.push(
				`{...({ ${JSON.stringify(name)}: ${isString ? JSON.stringify(strValue) : val === true ? '""' : use(val, ctx)} } as any)}`,
			);
			continue;
		}
		if (name === 'style' && val !== true) {
			// CSS text (a string, a template literal, a variable): a static page
			// (`<html static>`) writes a string as it is, as Pug did.
			// The type of `style` is an object: the CSS text goes in as it is.
			out.push(`style={(${isString ? JSON.stringify(strValue) : use(val, ctx)}) as any}`);
			continue;
		}
		const prop = propOf.get(name.toLowerCase()) ?? name;
		const kind = kindOf.get(prop);
		// `selected` of an option and `checked` of an input are not in the table (React writes
		// them in the code of the element). `disabled="disabled"` of Pug is the attribute
		// `disabled`, and the types of these props take a boolean, not a string (the kind
		// OVERLOADED_BOOLEAN, `download`, takes a string: it stays as written).
		const element = elementBooleans.has(`${tag.name}:${prop}`);
		if (val === true || ((element || kind === 1) && isString && strValue === name)) {
			// BOOLEAN kinds are bare; others are empty strings. An empty string is not selected
			// or checked.
			out.push(kind === 1 || kind === 2 || element ? prop : `${prop}=""`);
		} else if (
			isString &&
			NUMBER_PROPS.has(prop) &&
			/^-?(?:0|[1-9]\d*)$/.test(strValue)
		) {
			// `maxlength="255"` of Pug: the types of these props are `number`.
			out.push(`${prop}={${strValue}}`);
		} else if (isString && prop === 'hidden' && strValue === 'until-found') {
			// The type of `hidden` of @types/react has no `until-found` (it is a value of HTML).
			out.push(`${prop}={${JSON.stringify(strValue)} as any}`);
		} else if (isString) {
			out.push(
				/["&<>{}\\]/.test(strValue)
					? `${prop}={${JSON.stringify(strValue)}}`
					: `${prop}="${strValue}"`,
			);
		} else if (/^(?:data|aria)-/i.test(name) || ENUMERATED_BOOLEAN_PROPS.has(prop)) {
			// A value of true is an empty attribute in Pug (an HTML5 page, as the bare
			// attribute above), and false leaves it out; React writes "true" and "false" for
			// `data-*`, `aria-*` and the props whose values are those words (`draggable`).
			const v = use(val, ctx);
			out.push(
				`${prop}={((v: any) => (v === true ? "" : v === false ? undefined : v))(${v})}`,
			);
		} else {
			// Pug leaves out an attribute whose value is `false` or `null`, as it does for
			// `undefined`: such a branch of a condition is `undefined`, which the types of a
			// text prop take. A boolean prop and a boolean-ish one (`value`) mean something
			// with `false`, which stays; their `null` is not written by React either.
			const value = omittedBranchesToUndefined(val, acorn, {
				keepFalse: kind === 1 || kind === 2 || kind === 5,
			});
			out.push(`${prop}={${use(value, ctx)}}`);
		}
		if (name === 'id') id = true;
	}
	if (classes.length > 0) {
		if (classes.every((c) => typeof c === 'string'))
			out.unshift(`className="${classes.join(' ')}"`);
		else
			out.unshift(
				`className={[${classes.map((c) => (typeof c === 'string' ? JSON.stringify(c) : c.expr)).join(', ')}].filter(Boolean).join(' ')}`,
			);
	}
	// Cast, so that an element whose only attribute is one of these is not an error of the
	// types ("no properties in common").
	if (spread.length > 0) out.push(`{...({ ${spread.join(', ')} } as any)}`);
	return out;
}

/**
 *
 * @param n
 * @param ctx
 * @param depth
 */
function node(n, ctx, depth) {
	const pad = indent(depth);
	switch (n.type) {
		case 'Comment': {
			// `// text` is an HTML comment in the page (`//-` is not); JSX cannot
			// write one, so it is written as markup.
			if (!n.buffer) return [];
			ctx.rt.add('html');
			// Pug's `pretty` starts a comment on a new line.
			const lead = PRETTY && !ctx.pre ? [`${pad}{"\\n"}`] : [];
			return [...lead, `${pad}{html(${JSON.stringify(`<!--${n.val}-->`)})}`];
		}
		case 'Doctype':
		case 'BlockComment': {
			return [];
		}
		case 'Text': {
			const t = n.val;
			if (/</.test(t)) {
				// A line of HTML written in the template (`<meta ...>`, `<!--#include ...-->`).
				ctx.rt.add('html');
				return [`${pad}{html(${JSON.stringify(t)})}`];
			}
			// In `pre` / `textarea` the line breaks and the indentation are the text:
			// bare JSX text would lose the white space at the edges of each line, and
			// the `\n` nodes of a `.` block or of `|` lines would turn into a space.
			if (ctx.pre > 0) {
				// An entity (`&lt;`) is what Pug passed on as it was; a string would show the `&`.
				if (/&(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);/.test(t)) {
					ctx.rt.add('html');
					return [`${pad}{html(${JSON.stringify(t)})}`];
				}
				return [`${pad}{${JSON.stringify(t)}}`];
			}
			if (t.trim() === '' && t.includes('\n')) return [`${pad}{' '}`];
			return [`${pad}${jsxText(t)}`];
		}
		case 'Code': {
			// Buffered output.
			const expr = use(n.val, ctx);
			if (!n.mustEscape) {
				// Raw HTML next to other children: the helper of kamado/jsx.
				ctx.rt.add('html');
				return [`${pad}{html(${expr})}`];
			}
			return [`${pad}{${expr}}`];
		}
		case 'Tag': {
			const attrs = attrsOf(n, ctx);
			// Pug writes a page in the order it was written: nothing moves into the
			// head, form controls keep the order of their attributes and so does the
			// `selected` of an option (a `defaultValue` on the select would move it last).
			if (n.name === 'html') attrs.push('static');
			const open = attrs.length > 0 ? `${n.name} ${attrs.join(' ')}` : n.name;
			const kids = n.block ? n.block.nodes : [];
			// Pug's `pretty` writes a line break before every tag that is not inline
			// and before the closing tag of one with a block inside; it is white space
			// that survives into the page, so it is written out.
			const lead = PRETTY && !ctx.pre && !PUG_INLINE.has(n.name) ? [`${pad}{"\\n"}`] : [];
			const tail =
				lead.length > 0 &&
				!canInline(kids) &&
				// Text-only elements: the white space is not part of their text.
				!['script', 'style', 'title', 'option', 'textarea', 'pre'].includes(n.name);
			if (VOID.has(n.name) && kids.length === 0) return [...lead, `${pad}<${open} />`];
			if (kids.length === 0) return [...lead, `${pad}<${open}></${n.name}>`];
			// A sole unescaped value or raw text block.
			if (
				kids.length === 1 &&
				kids[0].type === 'Code' &&
				kids[0].buffer &&
				!kids[0].mustEscape
			) {
				return [
					...lead,
					`${pad}<${open} dangerouslySetInnerHTML={{ __html: ${use(kids[0].val, ctx)} }} />`,
				];
			}
			if (n.name === 'style' || n.name === 'script') {
				if (kids.every((k) => k.type === 'Text')) {
					// The line breaks of a `.` block are nodes of their own: pug-code-gen writes the
					// values of the text nodes one after another, as they are, so a `\n` between
					// them would make three of each.
					return [
						...lead,
						`${pad}<${open} dangerouslySetInnerHTML={{ __html: ${JSON.stringify(blockText(kids))} }} />`,
					];
				}
			}
			const sensitive = n.name === 'pre' || n.name === 'textarea';
			if (sensitive) ctx.pre = (ctx.pre ?? 0) + 1;
			const parts = children(kids, ctx, depth + 1);
			if (sensitive) ctx.pre -= 1;
			if (tail) parts.push(`${indent(depth + 1)}{"\\n"}`);
			return [...lead, `${pad}<${open}>`, ...parts, `${pad}</${n.name}>`];
		}
		case 'NamedBlock': {
			// In a layout: a block of code gives defaults for what a page passes, any
			// other block is what the page puts in `slots`, or the default.
			if (n.nodes.length > 0 && n.nodes.every((k) => k.type === 'Code' && !k.buffer)) {
				for (const k of n.nodes) {
					const mapped = mapExpr(k.val);
					const program = acorn.parse(mapped, { ecmaVersion: 'latest' });
					for (const st of program.body) {
						if (st.type !== 'VariableDeclaration') continue;
						for (const d of st.declarations) {
							const init = d.init
								? use(mapped.slice(d.init.start, d.init.end), ctx)
								: 'undefined';
							ctx.declared.add(d.id.name);
							ctx.hoisted.push(`const { ${d.id.name} = ${init} } = props as any;`);
						}
					}
				}
				return [];
			}
			const inner = block(n.nodes, ctx, depth + 1);
			return [
				`${pad}{(props as any).slots?.[${JSON.stringify(n.name)}] ?? (\n${inner}\n${pad})}`,
			];
		}
		case 'InterpolatedTag': {
			// `#{tag}`: a component whose type is the string in a variable; the
			// runtime accepts a string type as React does.
			const expr = use(n.expr, ctx);
			const inner = node({ ...n, type: 'Tag', name: 'DynTag' }, ctx, depth + 2);
			return [
				`${pad}{(() => {`,
				`${pad}\tconst DynTag: any = ${expr};`,
				`${pad}\treturn (`,
				`${pad}\t<>`,
				...inner,
				`${pad}\t</>`,
				`${pad}\t);`,
				`${pad}})()}`,
			];
		}
		case 'Conditional': {
			const condition = use(n.test, ctx);
			const test = `(${condition})`;
			ctx.nesting++;
			const cons = block(n.consequent.nodes, ctx, depth + 1);
			if (!n.alternate) {
				ctx.nesting--;
				// `!!`: a Pug `if` prints nothing for `0`, while `0 && x` is `0` in JSX. A
				// condition that is a boolean already needs none.
				const bool = booleanCondition(condition, acorn);
				return [`${pad}{${bool ?? `!!${test}`} && (\n${cons}\n${pad})}`];
			}
			// `else if` is another conditional: its expression, without the braces
			// that would make it a child.
			const alt =
				n.alternate.type === 'Block'
					? block(n.alternate.nodes, ctx, depth + 1)
					: `${indent(depth + 1)}${node(n.alternate, ctx, depth + 1)
							.join('\n')
							.trim()
							.slice(1, -1)}`;
			ctx.nesting--;
			return [`${pad}{${test} ? (\n${cons}\n${pad}) : (\n${alt}\n${pad})}`];
		}
		case 'Each': {
			const obj = use(n.obj, ctx);
			const added = [n.val, n.key].filter(Boolean);
			const before = new Set(ctx.declared);
			for (const a of added) ctx.declared.add(a);
			ctx.scope.push(added);
			ctx.nesting++;
			const inner = block(n.block.nodes, ctx, depth + 2);
			ctx.nesting--;
			ctx.scope.pop();
			ctx.declared = before;
			// A parameter that the body does not read is an error of `noUnusedParameters`: the
			// key goes, and the value starts with an underscore.
			const reads = (name) => isIdentifierUsed(inner, name);
			const params = [reads(n.val) ? n.val : `_${n.val}`];
			if (n.key && reads(n.key)) params.push(n.key);
			// What is looped over is known at the run: Pug loops over an array by index and
			// over an object by key, and `.map` is the array's alone.
			ctx.usesEach = true;
			const mapped = (entries) =>
				`${entries}.map(([${params.join(', ')}]: any) => (\n${inner}\n${pad}))`;
			if (n.alternate) {
				// `each ... else`: the block that shows when there is nothing to loop over.
				// What is looped over is read once.
				const other = block(n.alternate.nodes, ctx, depth + 2);
				return [
					`${pad}{(() => {\n${pad}\tconst _entries = _eachOf(${obj});\n${pad}\treturn _entries.length ? ${mapped('_entries')} : (\n${other}\n${pad}\t);\n${pad}})()}`,
				];
			}
			return [`${pad}{${mapped(`_eachOf(${obj})`)}}`];
		}
		case 'Include': {
			const p = path.extname(n.file.path) ? n.file.path : `${n.file.path}.pug`;
			const abs = p.startsWith('/')
				? path.join(libs, p)
				: path.resolve(path.dirname(ctx.file), p);
			const info = convertFile(abs);
			if (info.mixins.length > 0) {
				// A file of mixins is imported by name, and renders nothing where it is included.
				const toOut = (f) =>
					path.join(
						outRoot,
						'__assets',
						path.relative(path.join(srcRoot, '__assets'), f),
					);
				let mixinSpec = path
					.relative(path.dirname(toOut(ctx.file)), toOut(abs))
					.replace(/\.pug$/, '.tsx');
				if (!mixinSpec.startsWith('.')) mixinSpec = `./${mixinSpec}`;
				ctx.named.set(
					mixinSpec,
					info.mixins.map((m) => m.name),
				);
				for (const m of info.mixins) ctx.mixins.set(m.name, m);
				// A file that also writes markup shows it where it is included.
				if (!info.hasBody) return [];
			}
			// The default export of a file of mixins is named apart from them.
			const name = info.hasBody ? `${pascal(abs)}Body` : pascal(abs);
			const outFrom = path.join(
				outRoot,
				'__assets',
				path.relative(path.join(srcRoot, '__assets'), ctx.file),
			);
			const outTo = path.join(
				outRoot,
				'__assets',
				path.relative(path.join(srcRoot, '__assets'), abs),
			);
			let spec = path.relative(path.dirname(outFrom), outTo).replace(/\.pug$/, '.tsx');
			if (!spec.startsWith('.')) spec = `./${spec}`;
			// Inside of a `pre` the file is the component that writes its text as strings.
			let tag = name;
			if (ctx.pre > 0) {
				tag = `${name}Pre`;
				requestPre(abs, PRE_BODY);
				importPre(ctx, spec, tag);
			} else {
				ctx.imports.set(name, spec.replace(/\.tsx$/, '.tsx'));
			}
			// Locals the included file may use travel as props.
			const locals = [...ctx.declared].filter(
				(d) => (!PROP_NAMES.has(d) || ctx.shadowed.has(d)) && !DATA_VARS.has(d),
			);
			const passed = locals.map((l) => `${l}={${l}}`).join(' ');
			return [`${pad}<${tag} {...props}${passed ? ' ' + passed : ''} />`];
		}
		case 'RawInclude': {
			// A file that is not Pug is put in as it is. One of the data directory is
			// already a value of \`data\` (its name without the extension).
			const p = n.file.path;
			const abs = p.startsWith('/')
				? path.join(libs, p)
				: path.resolve(path.dirname(ctx.file), p);
			ctx.rt.add('html');
			const dataDir = path.join(libs, 'data') + path.sep;
			if (abs.startsWith(dataDir)) {
				const key = path.basename(abs, path.extname(abs));
				return [`${pad}{html((props.data as any)[${JSON.stringify(key)}])}`];
			}
			return [`${pad}{html(${JSON.stringify(readFileSync(abs, 'utf8'))})}`];
		}
		case 'Mixin': {
			if (!n.call) throw new Error(`a mixin defined in the middle of ${ctx.file}`);
			const mixin = ctx.mixins.get(component(n.name));
			if (!mixin) throw new Error(`+${n.name} is called in ${ctx.file} but not included`);
			// The arguments, split where acorn says they are.
			const source = `[${n.args ?? ''}]`;
			const list = n.args
				? acorn.parseExpressionAt(source, 0, { ecmaVersion: 'latest' }).elements
				: [];
			if (
				list.length > mixin.params.length ||
				list.some((e) => e.type === 'SpreadElement')
			) {
				throw new Error(
					`+${n.name} in ${ctx.file} is called with more arguments than it declares (or a spread): write it by hand`,
				);
			}
			if ((n.attributeBlocks ?? []).length > 0) {
				throw new Error(`+${n.name} in ${ctx.file} has &attributes: write it by hand`);
			}
			const given = list.map((e) => use(source.slice(e.start, e.end), ctx));
			const locals = [...ctx.declared].filter(
				(d) => (!PROP_NAMES.has(d) || ctx.shadowed.has(d)) && !DATA_VARS.has(d),
			);
			// A name twice is an error of the types (and the last one wins): an argument
			// takes the place of the local of the same name.
			const named = new Map(locals.map((l) => [l, `${l}={${l}}`]));
			const spreads = [];
			for (const [i, g] of given.entries()) {
				if (mixin.params[i].pattern) {
					spreads.push(`{...(${g})}`);
					// The spread comes last and sets these names: writing them before it is
					// an error of the types (TS2783), and changes nothing.
					for (const key of literalKeys(g, acorn)) named.delete(key);
				} else {
					named.set(mixin.params[i].name, `${mixin.params[i].name}={${g}}`);
				}
			}
			const passed = [...named.values(), ...spreads].join(' ');
			// Inside of a `pre` the mixin is the component that writes its text as strings.
			let tag = mixin.name;
			if (ctx.pre > 0) {
				tag = `${mixin.name}Pre`;
				requestPre(mixin.file, mixin.name);
				if (mixin.file !== ctx.file) {
					// A mixin of another file reaches the context only by an include, which names
					// the module it is imported from.
					const spec = [...ctx.named].find(([, names]) =>
						names.includes(mixin.name),
					)?.[0];
					if (spec === undefined) {
						throw new Error(`+${n.name} in ${ctx.file} is not imported from a module`);
					}
					importPre(ctx, spec, tag);
				}
			}
			const open = `${tag} {...props}${passed ? ' ' + passed : ''}`;
			if (n.block && n.block.nodes.length > 0) {
				// The block of the call is what the mixin's `block` writes.
				const inner = children(n.block.nodes, ctx, depth + 1);
				return [`${pad}<${open}>`, ...inner, `${pad}</${tag}>`];
			}
			return [`${pad}<${open} />`];
		}
		case 'Filter': {
			// `:name` with a function of that name that reads `data/<name>.html`
			// (a `filters.cjs` of the data directory): the file is the value of `data`.
			if (!existsSync(path.join(libs, 'data', `${n.name}.html`))) {
				throw new Error(
					`filter :${n.name} in ${ctx.file} has no data/${n.name}.html: write it by hand`,
				);
			}
			ctx.rt.add('html');
			return [`${pad}{html((props as any).data[${JSON.stringify(n.name)}])}`];
		}
		case 'MixinBlock': {
			return [`${pad}{(props as any).children}`];
		}
		default: {
			throw new Error(`unsupported pug node ${n.type} in ${ctx.file}`);
		}
	}
}

/**
 *
 * @param dir
 * @param fn
 */
function walkDir(dir, fn) {
	for (const e of readdirSync(dir)) {
		const p = path.join(dir, e);
		if (statSync(p).isDirectory()) walkDir(p, fn);
		else fn(p);
	}
}
const failures = [];
walkDir(path.join(srcRoot, '__assets'), (f) => {
	if (!f.endsWith('.pug') || SKIPS.some((text) => f.includes(text))) return;
	try {
		convertFile(f);
	} catch (error) {
		// A file nothing includes may be broken (an include of a file that is not
		// there): it is reported, and a page that fails fails the run.
		converted.delete(f);
		failures.push([f, error.message.split('\n')[0]]);
	}
});
// What was called inside of a `pre` is converted again with the component for it. That
// file may call more of them, from itself or from another file: until nothing new is asked.
const preDone = new Map();
for (let again = true; again;) {
	again = false;
	for (const [file, keys] of preNeeds) {
		if (preDone.get(file) === keys.size || !converted.has(file)) continue;
		preDone.set(file, keys.size);
		converted.delete(file);
		try {
			convertFile(file);
		} catch (error) {
			// What a call imports from it is not written: the run fails, whatever the file is.
			converted.delete(file);
			failures.push([file, error.message.split('\n')[0]]);
			process.exitCode = 1;
		}
		again = true;
	}
}
// The name of a layout has no extension (RFC §6), and the `.pug` that a sidecar `.json` or the
// front matter of a page names became a component: the name without `.pug` is written in a
// copy of the file under `<out>`, where the source is not touched. The rest of the file stays
// as it was, so that nothing else in a diff against the source moves. A name that no converted
// file ends with is written the same (the component may be written by hand) and warned of.
const converters = [...converted.keys()].map((f) => f.split(path.sep).join('/'));
const layoutRewritten = [];
/**
 * Writes the copy of a file whose `layout` names a `.pug` to the output.
 * @param file - The file in the project
 * @param name - The `layout` it has, with `.pug`
 * @param text - The text of the file with the name rewritten
 */
function writeLayoutCopy(file, name, text) {
	const rel = path.relative(srcRoot, file);
	const copy = path.join(outRoot, rel);
	mkdirSync(path.dirname(copy), { recursive: true });
	writeFileSync(copy, text);
	layoutRewritten.push(rel);
	// A name may start with `/` or `./`: what is looked for is the path it ends with.
	const tail = name.replace(/^(?:\.?\/)+/, '');
	if (!converters.some((c) => c.endsWith(`/${tail}`))) {
		warnings.add(`${rel}: layout "${name}" names no converted file`);
	}
}
/**
 * Where the text of the string that is the value of the top-level `layout` key of a JSON text
 * lies: the offsets of what is between its quotes (a `layout` of an object inside does not count).
 * With the key twice it is the last one, which `JSON.parse` reads.
 * @param text - The JSON text, which parses
 * @returns The offsets, or `undefined` when the key has no string as its value
 */
function topLevelLayout(text) {
	let found;
	const endOfString = (from) => {
		let end = from;
		while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
		return end;
	};
	let depth = 0;
	for (let i = 0; i < text.length; i++) {
		switch (text[i]) {
			case '"': {
				const end = endOfString(i + 1);
				if (depth === 1 && text.slice(i + 1, end) === 'layout') {
					const colon = /^\s*:\s*"/.exec(text.slice(end + 1));
					if (colon) {
						const start = end + 1 + colon[0].length;
						found = [start, endOfString(start)];
					}
				}
				i = end;
				break;
			}
			case '{':
			case '[': {
				depth++;
				break;
			}
			case '}':
			case ']': {
				depth--;
				break;
			}
		}
	}
	return found;
}
/**
 * Writes the copy of a sidecar JSON whose top-level `layout` names a `.pug`.
 * @param f - The JSON in the project
 */
function rewriteSidecarLayout(f) {
	const rel = path.relative(srcRoot, f);
	// A JSON is the sidecar of a page only with a page of its name next to it (`about.pug`,
	// `about.html`, `about.tsx`, `about.jsx`); any other is data, which is not read.
	const stem = f.slice(0, -'.json'.length);
	if (!['.pug', '.html', '.jsx', '.tsx'].some((ext) => existsSync(`${stem}${ext}`)))
		return;
	const text = readFileSync(f, 'utf8');
	let name;
	try {
		name = JSON.parse(text)?.layout;
	} catch {
		const named = /"layout"\s*:\s*"([^"\\]*\.pug)"/.exec(text)?.[1];
		if (named !== undefined) {
			warnings.add(`${rel}: not valid JSON, the layout "${named}" is not rewritten`);
		}
		return;
	}
	if (typeof name !== 'string' || !name.endsWith('.pug')) return;
	const at = topLevelLayout(text);
	if (at === undefined || !text.slice(at[0], at[1]).endsWith('.pug')) {
		warnings.add(`${rel}: the layout "${name}" is not rewritten`);
		return;
	}
	// Only `.pug` is cut from the text: no replacement string reads `$` in a name.
	writeLayoutCopy(f, name, text.slice(0, at[1] - 4) + text.slice(at[1]));
}
/**
 * Writes the copy of a page whose front matter has a `layout` that names a `.pug`.
 * @param f - The `.html` in the project
 */
function rewriteFrontMatterLayout(f) {
	const rel = path.relative(srcRoot, f);
	const text = readFileSync(f, 'utf8');
	// A byte order mark in front of the `---` is not a part of the front matter.
	const bom = text.startsWith(String.fromCodePoint(0xfe_ff)) ? 1 : 0;
	const front = /^---\r?\n[\s\S]*?\r?\n---(?=\r?\n|$)/.exec(text.slice(bom))?.[0];
	if (front === undefined) return;
	const line =
		/^layout[ \t]*:[ \t]*(["']?)([^"'\s#][^"'\r\n#]*?\.pug)\1(?=[ \t]*(?:#.*)?\r?$)/m.exec(
			front,
		);
	if (!line) {
		// A `layout` of a form that is not read (a `#` in the name, a flow style): the page
		// would keep naming the `.pug`, and the build of v3 would not find the layout.
		if (/^layout[ \t]*:.*\.pug/m.test(front)) {
			warnings.add(`${rel}: the layout of the front matter is not rewritten`);
		}
		return;
	}
	const end = bom + line.index + line[0].length - line[1].length;
	writeLayoutCopy(f, line[2], text.slice(0, end - 4) + text.slice(end));
}
walkDir(path.join(srcRoot, '__assets'), (f) => {
	if (SKIPS.some((text) => f.includes(text))) return;
	switch (path.extname(f)) {
		case '.json': {
			rewriteSidecarLayout(f);
			break;
		}
		case '.html': {
			rewriteFrontMatterLayout(f);
			break;
		}
	}
});
// The pages use `<html static>` and may use `command` / `commandfor`: the types of
// @types/react do not know them, so they are declared next to the pages.
const declarations = path.join(outRoot, '__assets', 'kamado-jsx.d.ts');
mkdirSync(path.dirname(declarations), { recursive: true });
writeFileSync(declarations, jsxDeclarations());
console.log([...converted].length, 'files converted');
for (const rel of layoutRewritten) console.log(`layout rewritten: ${rel}`);
for (const warning of warnings) console.log(`warning: ${warning}`);
for (const [f, message] of failures)
	console.log(`not converted: ${path.relative(srcRoot, f)}: ${message}`);
if (failures.some(([f]) => inPages(f))) process.exitCode = 1;
