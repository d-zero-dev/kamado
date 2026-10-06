/* eslint-disable import-x/no-extraneous-dependencies, @typescript-eslint/no-unused-vars, unicorn/prefer-single-call, no-console, unicorn/no-array-for-each, unicorn/no-lonely-if -- a migration helper to be read and changed per project, not a library */
/**
 * A first pass of Pug to TSX for a migration to kamado v3 (docs/v3/MIGRATION.md).
 *
 * ```sh
 * node scripts/pug-to-tsx.mjs <project> <out> [libs dir, default <project>/__assets/_libs]
 * ```
 *
 * Converts every `.pug` under `<project>/__assets` to a component (`.tsx`, same
 * paths under `<out>/__assets`). `include` becomes a component that receives the
 * props of the file that includes it and the variables in scope; `each` and `if` become
 * `map` and `&&` / `?:`; `pkg.production.*` becomes `site.*` and `filters.date`
 * `formatDate`; comments and the doctype are dropped. What it cannot express it
 * stops on (raw HTML in text, an unescaped value that is not the only child):
 * fix the source or the output by hand. It needs the pug packages of the project
 * (`pug-lexer`, `pug-parser`, `acorn`) and a build of kamado-v3.
 *
 * Read the output before using it: the names of the data variables
 * (`data`, `blocks`) follow the files of the data directory, and `charset`,
 * `itemprop` and the like have to be camel case props (see MIGRATION.md 3.4).
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const [srcRoot, outRoot, libsArg] = process.argv
	.slice(2)
	.filter((a) => !a.startsWith('--'));
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
const { PROPS } = await import(
	new URL('../packages/kamado-v3/dist/jsx/attr-table.js', import.meta.url).href
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
const GLOBALS = new Set([
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
const DATA_VARS = new Set(['data', 'blocks']);

/**
 *
 * @param expr
 * @param declared
 */
function free(expr, declared) {
	const names = new Set();
	let ast;
	try {
		ast = acorn.parseExpressionAt(`(${expr})`, 0, { ecmaVersion: 'latest' });
	} catch (error) {
		throw new Error(`cannot parse expression: ${expr}: ${error.message}`);
	}
	const walk = (node, scope) => {
		if (!node || typeof node.type !== 'string') return;
		switch (node.type) {
			case 'Identifier': {
				if (!scope.has(node.name)) names.add(node.name);
				return;
			}
			case 'MemberExpression': {
				walk(node.object, scope);
				if (node.computed) walk(node.property, scope);
				return;
			}
			case 'Property': {
				if (node.computed) walk(node.key, scope);
				walk(node.value, scope);
				return;
			}
			case 'ArrowFunctionExpression':
			case 'FunctionExpression': {
				const inner = new Set(scope);
				for (const p of node.params) if (p.type === 'Identifier') inner.add(p.name);
				walk(node.body, inner);
				return;
			}
			default: {
				for (const key of Object.keys(node)) {
					const v = node[key];
					if (Array.isArray(v)) v.forEach((c) => walk(c, scope));
					else if (v && typeof v.type === 'string') walk(v, scope);
				}
			}
		}
	};
	walk(ast, new Set(declared));
	return names;
}

/**
 *
 * @param expr
 */
function mapExpr(expr) {
	return expr
		.replaceAll(/\bpkg\.production\./g, 'site.')
		.replaceAll(/\bfilters\.date\(/g, 'formatDate(');
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
 * pug-code-gen's `tagCanInline`: only text without a line break and inline tags inside.
 * @param nodes
 */
function canInline(nodes) {
	return nodes.every(
		(k) =>
			(k.type === 'Text' && !/\n/.test(k.val)) ||
			(k.type === 'Tag' && PUG_INLINE.has(k.name)),
	);
}
const skipped = [];
const queue = [];

/**
 *
 * @param file
 */
function pascal(file) {
	return path
		.basename(file, '.pug')
		.split(/[-_.]/)
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
	return text;
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
	const names = [];
	for (const prop of pattern.properties) {
		const v = prop.type === 'RestElement' ? prop.argument : prop.value;
		const target = v.type === 'AssignmentPattern' ? v.left : v;
		if (target.type === 'Identifier') names.push(target.name);
	}
	return names;
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
	const lines = [
		`${exported} function ${name}(props: PageProps & Record<string, any>) {`,
	];
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
		lines.push(`\tconst { ${external.join(', ')} } = _vars;`);
	}
	for (const h of ctx.hoisted) lines.push(`\t${h}`);
	lines.push(`\treturn (\n${body}\n\t);`);
	lines.push('}');
	return lines.join('\n');
}

/**
 *
 * @param ctx
 */
function importLines(ctx) {
	const head = ["import type { PageProps } from 'kamado-v3';"];
	if (ctx.rt.size > 0)
		head.push(`import { ${[...ctx.rt].join(', ')} } from 'kamado-v3/jsx';`);
	for (const [name, spec] of ctx.imports) head.push(`import ${name} from '${spec}';`);
	for (const [spec, names] of ctx.named)
		head.push(`import { ${names.join(', ')} } from '${spec}';`);
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
		const head = new Set();
		const parts = [];
		for (const def of defs) {
			const params = mixinParams(def.args);
			info.mixins.push({ name: component(def.name), params });
			const ctx = newContext(file);
			for (const p of params) {
				if (p.pattern) for (const n of p.names) ctx.declared.add(n);
				else ctx.declared.add(p.name);
			}
			const body = block(def.block.nodes, ctx, 1);
			for (const l of importLines(ctx)) head.add(l);
			parts.push(componentText(ctx, component(def.name), body, 'export', params));
		}
		text = [...head].join('\n') + '\n\n' + parts.join('\n\n') + '\n';
	} else {
		const ctx = newContext(file);
		const body = block(ast.nodes, ctx, 1);
		// A page that is a fragment has no `<html static>` to say it is written in
		// the order of the template: its meta says so.
		const fragmentPage =
			file.includes(`${path.sep}htdocs${path.sep}`) &&
			!ast.nodes.some((n) => n.type === 'Tag' && n.name === 'html');
		text =
			importLines(ctx).join('\n') +
			'\n\n' +
			(fragmentPage ? 'export const meta = { static: true };\n\n' : '') +
			componentText(ctx, pascal(file), body, 'export default', []) +
			'\n';
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
	const parent = extended.file.path.startsWith('/')
		? path.join(libs, extended.file.path)
		: path.resolve(path.dirname(file), extended.file.path);
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
	const head = new Set();
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
		for (const l of importLines(mixCtx)) head.add(l);
		parts.push(componentText(mixCtx, component(def.name), body, '', params).trim());
	}

	const blocks = ast.nodes.filter((n) => n.type === 'NamedBlock');
	for (const v of blocks.filter((n) => n.name === 'vars')) children(v.nodes, ctx, 0);
	const given = [...ctx.declared];
	const slots = [];
	for (const n of blocks.filter((b) => b.name !== 'vars')) {
		slots.push(`\t\t\t${n.name}: (\n${block(n.nodes, ctx, 4)}\n\t\t\t)`);
	}
	const body = `\t\t<${parentName} {...props}${given.length > 0 ? ` {...{ ${given.join(', ')} }}` : ''} slots={{\n${slots.join(',\n')},\n\t\t}} />`;
	for (const l of importLines(ctx)) head.add(l);
	return (
		[...head].join('\n') +
		'\n\n' +
		parts.join('\n\n') +
		(parts.length > 0 ? '\n\n' : '') +
		componentText(ctx, pascal(file), body, 'export default', []) +
		'\n'
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
	return mapped;
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
		if (n.type === 'Code' && !n.buffer && ctx.nesting === 0) {
			// Pug code is visible to the rest of the template: it goes to the top.
			for (const d of declaredBy(n.val)) ctx.declared.add(d);
			ctx.hoisted.push(useStmt(n.val, ctx));
			continue;
		}
		if (n.type === 'Code' && !n.buffer) {
			// Statements: the rest of the siblings go into a function that sees them.
			const stmts = [];
			let j = i;
			while (j < nodes.length && nodes[j].type === 'Code' && !nodes[j].buffer) {
				stmts.push(nodes[j].val);
				for (const d of declaredBy(nodes[j].val)) ctx.declared.add(d);
				j++;
			}
			const rest = children(nodes.slice(j), ctx, depth + 2);
			const stmtCode = stmts
				.map((s) => `${indent(depth + 1)}${useStmt(s, ctx)}`)
				.join('\n');
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
 */
function declaredBy(stmt) {
	const names = [];
	const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
	let m;
	while ((m = re.exec(stmt))) names.push(m[1]);
	return names;
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
	// name declared earlier in the same code block is not a free one.
	const local = [...ctx.declared];
	const declare = [];
	const read = (node) => {
		for (const n of free(mapped.slice(node.start, node.end), local)) ctx.used.add(n);
	};
	for (const node of program.body) {
		if (node.type === 'VariableDeclaration') {
			for (const d of node.declarations) {
				if (d.init) read(d.init);
				if (d.id.type === 'Identifier') local.push(d.id.name);
			}
		} else if (node.type === 'ExpressionStatement') {
			const e = node.expression;
			if (
				e.type === 'AssignmentExpression' &&
				e.left.type === 'Identifier' &&
				!local.includes(e.left.name)
			) {
				// Pug code may assign a variable it never declared: it becomes a local.
				read(e.right);
				declare.push(e.left.name);
				local.push(e.left.name);
				ctx.declared.add(e.left.name);
			} else {
				read(e);
			}
		}
	}
	const prefix = declare.map((n) => `let ${n}: any;`).join(' ');
	const text = mapped.endsWith(';') || mapped.endsWith('}') ? mapped : `${mapped};`;
	return prefix ? `${prefix} ${text}` : text;
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
				return /^(["'])[\s\S]*\1$/.test(value.val)
					? `"${value.val.slice(1, -1)}"`
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
		if (name === 'style' && isString) {
			// React wants an object: `a-b: c; --d: e` is `{ aB: "c", "--d": "e" }`.
			const pairs = strValue
				.split(';')
				.map((d) => d.trim())
				.filter(Boolean)
				.map((d) => {
					const at = d.indexOf(':');
					const key = d.slice(0, at).trim();
					const value = d.slice(at + 1).trim();
					const camel = key.startsWith('--')
						? JSON.stringify(key)
						: key.replaceAll(/-([a-z])/g, (_, c) => c.toUpperCase());
					return `${camel}: ${JSON.stringify(value)}`;
				});
			out.push(`style={{ ${pairs.join(', ')} }}`);
			continue;
		}
		if (name === 'style' && !isString && val !== true) {
			// CSS text built at run time (a template literal, a variable).
			ctx.rt.add('styleOf');
			out.push(`style={styleOf(${use(val, ctx)})}`);
			continue;
		}
		const prop = propOf.get(name.toLowerCase()) ?? name;
		const kind = kindOf.get(prop);
		if (val === true) {
			// BOOLEAN kinds are bare; others are empty strings.
			out.push(kind === 1 || kind === 2 ? prop : `${prop}=""`);
		} else if (isString) {
			out.push(
				strValue.includes('"')
					? `${prop}={${JSON.stringify(strValue)}}`
					: `${prop}="${strValue}"`,
			);
		} else if (/^(?:data|aria)-/i.test(name)) {
			// Pug leaves out an attribute whose value is false; React writes "false".
			const v = use(val, ctx);
			out.push(`${prop}={(${v}) === false ? undefined : (${v})}`);
		} else {
			out.push(`${prop}={${use(val, ctx)}}`);
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
		case 'Doctype':
		case 'Comment':
		case 'BlockComment': {
			return [];
		}
		case 'Text': {
			const t = n.val;
			if (t.trim() === '' && t.includes('\n')) return [`${pad}{' '}`];
			return [`${pad}${jsxText(t)}`];
		}
		case 'Code': {
			// Buffered output.
			const expr = use(n.val, ctx);
			if (!n.mustEscape) {
				// Raw HTML next to other children: the helper of kamado-v3/jsx.
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
				!['script', 'style', 'title', 'option', 'textarea'].includes(n.name);
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
					return [
						...lead,
						`${pad}<${open} dangerouslySetInnerHTML={{ __html: ${JSON.stringify(kids.map((k) => k.val).join('\n'))} }} />`,
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
			return [`${pad}{(props as any).slots?.${n.name} ?? (\n${inner}\n${pad})}`];
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
			return [`${pad}{${obj}.map((${added.join(', ')}) => (\n${inner}\n${pad}))}`];
		}
		case 'Include': {
			const p = n.file.path;
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
				return [];
			}
			const name = pascal(abs);
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
				(d) => !PROP_NAMES.has(d) && !DATA_VARS.has(d),
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
			const given = list.map((e) => use(source.slice(e.start, e.end), ctx));
			const locals = [...ctx.declared].filter(
				(d) => !PROP_NAMES.has(d) && !DATA_VARS.has(d),
			);
			const passed = [
				...locals.map((l) => `${l}={${l}}`),
				...given.map((g, i) =>
					mixin.params[i].pattern ? `{...(${g})}` : `${mixin.params[i].name}={${g}}`,
				),
			].join(' ');
			return [`${pad}<${mixin.name} {...props}${passed ? ' ' + passed : ''} />`];
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
walkDir(path.join(srcRoot, '__assets'), (f) => {
	if (f.endsWith('.pug') && !f.includes('/mixin/meta-example')) convertFile(f);
});
console.log([...converted].length - skipped.length, 'files converted');
for (const f of skipped) console.log('skipped (extends / block, write by hand):', f);
