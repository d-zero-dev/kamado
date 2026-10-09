/* eslint-disable import-x/no-extraneous-dependencies, @typescript-eslint/no-unused-vars, unicorn/prefer-single-call, no-console, unicorn/no-lonely-if -- a migration helper to be read and changed per project, not a library */
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
 * `map` and `&&` / `?:`; `pkg.production.*` becomes `site.*` and `filters.date`
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
	isIdentifierUsed,
	jsxDeclarations,
	literalKeys,
	omittedBranchesToUndefined,
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
const lex = require('pug-lexer');
const parse = require('pug-parser');
const libs = libsArg ?? path.join(srcRoot, '__assets', '_libs');
const VOID = new Set(
	'area base br col embed hr img input link meta param source track wbr'.split(' '),
);
// html attribute name (lower case) -> React prop name
const { REACT_PROP_NAMES } = await import('./react-prop-names.mjs');
const { PROPS } = await import(
	new URL('../packages/kamado/dist/jsx/attr-table.js', import.meta.url).href
);
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
	if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') {
		out.add(node.left.name);
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
	const plain = params.filter((p) => !p.pattern);
	if (plain.length > 0) {
		const list = plain.map((p) => (p.init ? `${p.name} = ${p.init}` : p.name));
		lines.push(`\tconst { ${list.join(', ')} } = props as any;`);
	}
	for (const p of params.filter((q) => q.pattern)) {
		lines.push(`\tconst ${p.pattern} = props as any;`);
	}
	if (fromProps.length > 0)
		lines.push(`\tconst { ${fromProps.join(', ')} } = props as any;`);
	if (dataVars.length > 0) {
		lines.push('\tconst _data = (props as any).data;');
		for (const v of dataVars) lines.push(`\tconst ${v} = _data.${v};`);
	}
	if (external.length > 0) {
		lines.push('\tconst _vars = { ...(props as any).meta, ...props } as any;');
		lines.push(
			`\t${external.some((n) => ctx.assigned.has(n)) ? 'let' : 'const'} { ${external.join(', ')} } = _vars;`,
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
	// The package ships no props types: the page props are declared where they are used.
	const head = ['type PageProps = Record<string, any>;'];
	if (rt.size > 0) head.push(`import { ${[...rt].join(', ')} } from 'kamado/jsx';`);
	for (const [name, spec] of imports) head.push(`import ${name} from '${spec}';`);
	for (const [spec, names] of named)
		head.push(`import { ${[...names].join(', ')} } from '${spec}';`);
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
			});
		}
		// What the file includes at its top level (other files of mixins) is seen by
		// every mixin of it.
		const top = newContext(file);
		for (const n of ast.nodes) if (n.type === 'Include') node(n, top, 0);
		for (const def of defs) {
			const params = mixinParams(def.args);
			info.mixins.push({ name: component(def.name), params });
			const ctx = newContext(file);
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
			parts.push(componentText(ctx, component(def.name), body, 'export', params));
		}
		// What the file writes besides its mixins is a component of its own (the
		// default export), which is what including the file shows.
		const rest = ast.nodes.filter(
			(n) =>
				!(n.type === 'Mixin' && !n.call) &&
				!['Include', 'Comment', 'BlockComment'].includes(n.type) &&
				!(n.type === 'Code' && !n.buffer),
		);
		if (rest.length > 0) {
			const ctx = newContext(file);
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
			parts.push(componentText(ctx, `${pascal(file)}Body`, body, 'export default', []));
			info.hasBody = true;
		}
		text = pruneUnusedImports(
			importLines(...contexts).join('\n') + '\n\n' + parts.join('\n\n') + '\n',
		);
	} else {
		const ctx = newContext(file);
		const body = block(ast.nodes, ctx, 1);
		// A page that is a fragment has no `<html static>` to say it is written in
		// the order of the template: its meta says so.
		const fragmentPage =
			inPages(file) && !ast.nodes.some((n) => n.type === 'Tag' && n.name === 'html');
		text = pruneUnusedImports(
			importLines(ctx).join('\n') +
				'\n\n' +
				(fragmentPage ? 'export const meta = { kdStatic: true };\n\n' : '') +
				componentText(ctx, pascal(file), body, 'export default', []) +
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
		});
	}
	const contexts = [ctx];
	const parts = [];
	for (const def of defs) {
		const params = mixinParams(def.args);
		const mixCtx = newContext(file);
		mixCtx.mixins = ctx.mixins;
		for (const p of params) {
			if (p.pattern) for (const n of p.names) mixCtx.declared.add(n);
			else mixCtx.declared.add(p.name);
		}
		const body = block(def.block.nodes, mixCtx, 1);
		contexts.push(mixCtx);
		parts.push(componentText(mixCtx, component(def.name), body, '', params).trim());
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
	for (const v of blocks.filter((n) => n.name === 'vars')) children(v.nodes, ctx, 0);
	const given = [...ctx.declared];
	const slots = [];
	for (const n of blocks.filter((b) => b.name !== 'vars')) {
		slots.push(`\t\t\t${JSON.stringify(n.name)}: (\n${block(n.nodes, ctx, 4)}\n\t\t\t)`);
	}
	const body = `\t\t<${parentName} {...props}${given.length > 0 ? ` {...{ ${given.join(', ')} }}` : ''} slots={{\n${slots.join(',\n')},\n\t\t}} />`;
	// A fragment of slots is evaluated before the layout's `<html static>` is
	// reached, so the page says it is static itself.
	return pruneUnusedImports(
		importLines(...contexts).join('\n') +
			'\n\n' +
			'export const meta = { kdStatic: true };\n\n' +
			parts.join('\n\n') +
			(parts.length > 0 ? '\n\n' : '') +
			componentText(ctx, pascal(file), body, 'export default', []) +
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
/**
 * The `value` (as a JSX attribute value) of the first option marked `selected` below `nodes`.
 * @param nodes
 */
function selectedValue(nodes) {
	for (const n of nodes) {
		if (n.type === 'Tag' && n.name === 'option') {
			const has = n.attrs.some((a) => a.name === 'selected');
			const value = n.attrs.find((a) => a.name === 'value');
			if (has && value && typeof value.val === 'string') {
				return isStringLiteral(value.val)
					? `{${JSON.stringify(value.val.slice(1, -1).replaceAll(/\\(["'\\])/g, '$1'))}}`
					: `{${value.val}}`;
			}
		}
		const inner = n.block?.nodes ?? n.consequent?.nodes ?? [];
		const found = selectedValue(inner);
		if (found !== undefined) return found;
	}
	return;
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
		if (/[^\w:.-]/.test(name)) {
			// A name JSX cannot write (and React would not render): spread an object.
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
				`{...{ ${JSON.stringify(name)}: ${isString ? JSON.stringify(strValue) : val === true ? '""' : use(val, ctx)} }}`,
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
		if (val === true) {
			// BOOLEAN kinds are bare; others are empty strings.
			out.push(kind === 1 || kind === 2 ? prop : `${prop}=""`);
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
		} else if (/^(?:data|aria)-/i.test(name)) {
			// Pug leaves out an attribute whose value is false; React writes "false".
			const v = use(val, ctx);
			out.push(`${prop}={((v: any) => (v === false ? undefined : v))(${v})}`);
		} else {
			// Pug leaves out an attribute whose value is `false` or `null`, as it does for
			// `undefined`: such a branch of a condition is `undefined`, which the types of a
			// text prop take. A boolean prop and a boolean-ish one (`draggable`) mean something
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
	if (spread.length > 0) out.push(`{...{ ${spread.join(', ')} }}`);
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
			if (t.trim() === '' && t.includes('\n')) return [`${pad}{' '}`];
			if (/</.test(t)) {
				// A line of HTML written in the template (`<meta ...>`, `<!--#include ...-->`).
				ctx.rt.add('html');
				return [`${pad}{html(${JSON.stringify(t)})}`];
			}
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
			if (n.name === 'select') {
				// React ignores `selected` on an option: the select says which one is.
				const chosen = selectedValue(n.block ? n.block.nodes : []);
				if (chosen !== undefined) attrs.push(`defaultValue=${chosen}`);
			}
			if (n.name === 'option') {
				const at = attrs.findIndex((a) => a === 'selected' || a.startsWith('selected='));
				if (at !== -1) attrs.splice(at, 1);
			}
			// Pug writes a page in the order it was written: nothing moves into the
			// head and form controls keep the order of their attributes.
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
			const test = '(' + use(n.test, ctx) + ')';
			ctx.nesting++;
			const cons = block(n.consequent.nodes, ctx, depth + 1);
			if (!n.alternate) {
				ctx.nesting--;
				// `!!`: a Pug `if` prints nothing for `0`, while `0 && x` is `0` in JSX.
				return [`${pad}{!!${test} && (\n${cons}\n${pad})}`];
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
			const mapped = `${obj}.map((${params.map((a) => `${a}: any`).join(', ')}) => (\n${inner}\n${pad}))`;
			if (n.alternate) {
				// `each ... else`: the block that shows when there is nothing to loop over.
				const other = block(n.alternate.nodes, ctx, depth + 2);
				return [`${pad}{(${obj}).length ? ${mapped} : (\n${other}\n${pad})}`];
			}
			return [`${pad}{${mapped}}`];
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
			ctx.imports.set(name, spec.replace(/\.tsx$/, '.tsx'));
			// Locals the included file may use travel as props.
			const locals = [...ctx.declared].filter(
				(d) => (!PROP_NAMES.has(d) || ctx.shadowed.has(d)) && !DATA_VARS.has(d),
			);
			const passed = locals.map((l) => `${l}={${l}}`).join(' ');
			return [`${pad}<${name} {...props}${passed ? ' ' + passed : ''} />`];
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
			const open = `${mixin.name} {...props}${passed ? ' ' + passed : ''}`;
			if (n.block && n.block.nodes.length > 0) {
				// The block of the call is what the mixin's `block` writes.
				const inner = children(n.block.nodes, ctx, depth + 1);
				return [`${pad}<${open}>`, ...inner, `${pad}</${mixin.name}>`];
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
// The pages use `<html static>` and may use `command` / `commandfor`: the types of
// @types/react do not know them, so they are declared next to the pages.
const declarations = path.join(outRoot, '__assets', 'kamado-jsx.d.ts');
mkdirSync(path.dirname(declarations), { recursive: true });
writeFileSync(declarations, jsxDeclarations());
console.log([...converted].length, 'files converted');
for (const [f, message] of failures)
	console.log(`not converted: ${path.relative(srcRoot, f)}: ${message}`);
if (failures.some(([f]) => inPages(f))) process.exitCode = 1;
