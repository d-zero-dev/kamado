/**
 * The pure parts of `pug-to-tsx.mjs` that make its output pass the type check of
 * `@d-zero/tsconfig` (strictest): types for the JavaScript that Pug code is, and the
 * declarations of what the pages use and `@types/react` does not have.
 *
 * The JavaScript is changed through its syntax tree (acorn): only the places that the tree
 * names get a type, so that the text of a string or a comment is never touched.
 */

/**
 * @typedef {{
 * 	parse: (input: string, options: { ecmaVersion: 'latest' }) => any;
 * 	parseExpressionAt: (input: string, offset: number, options: { ecmaVersion: 'latest' }) => any;
 * }} Parser - What the converter takes of acorn (the one of the project that it converts)
 */

/**
 * Whether the code reads an identifier: the name as a whole (not a part of another name)
 * and not as the property of an object (`a.props` is not the `props`; `...props` is).
 * Text and strings that hold the name count as a use, which only keeps what could go.
 * @param {string} code - The code
 * @param {string} name - An identifier (`$` is allowed)
 * @returns {boolean}
 * @example
 * isIdentifierUsed('<A {...props} />', 'props'); // true
 * isIdentifierUsed('a.props.b', 'props'); // false
 * isIdentifierUsed('MetaBody', 'Meta'); // false
 */
export function isIdentifierUsed(code, name) {
	const escaped = name.replaceAll('$', String.raw`\$`);
	return new RegExp(`(?<![\\w$])(?<![\\w$)\\]]\\.)${escaped}(?![\\w$])`).test(code);
}

/**
 * @typedef {{ start: number; end: number; text: string }} Edit - A replacement in a text
 */

/**
 * Where the types go in the tree of Pug code: the parameters of the functions, which
 * `noImplicitAny` refuses without a type, and (in a program) the constants that an object
 * literal initialises, which are indexed by a name known only when the page is built.
 * @param {string} code - The code the tree was read from
 * @param {any} tree - A Program, or an expression
 * @returns {Edit[]}
 */
function typeEdits(code, tree) {
	/** @type {Edit[]} */
	const edits = [];
	/**
	 * @param {number} at - Offset
	 * @param {string} text - What to put there
	 */
	const insert = (at, text) => edits.push({ start: at, end: at, text });
	/**
	 * @param {any} param - A parameter of a function
	 * @param {any} fn - The function
	 */
	const annotate = (param, fn) => {
		switch (param.type) {
			case 'Identifier': {
				// `x => x` (or `async x => x`) has no parentheses: there is no `(` before its one
				// parameter, from the start of the function.
				if (
					fn.type === 'ArrowFunctionExpression' &&
					!code.slice(fn.start, param.start).includes('(')
				) {
					// `x => x` has no parentheses to put the type in.
					edits.push({
						start: param.start,
						end: param.end,
						text: `(${param.name}: any)`,
					});
				} else {
					insert(param.end, ': any');
				}
				break;
			}
			case 'ObjectPattern':
			case 'ArrayPattern': {
				insert(param.end, ': any');
				break;
			}
			case 'AssignmentPattern': {
				insert(param.left.end, ': any');
				break;
			}
			case 'RestElement': {
				if (param.argument.type === 'Identifier') {
					insert(param.argument.end, ': any[]');
				}
				break;
			}
		}
	};
	/** @param {any} node */
	const visit = (node) => {
		if (!node || typeof node.type !== 'string') {
			return;
		}
		if (
			node.type === 'ArrowFunctionExpression' ||
			node.type === 'FunctionExpression' ||
			node.type === 'FunctionDeclaration'
		) {
			for (const param of node.params) {
				annotate(param, node);
			}
		}
		for (const key of Object.keys(node)) {
			const value = node[key];
			if (Array.isArray(value)) {
				for (const child of value) {
					visit(child);
				}
			} else if (value && typeof value.type === 'string') {
				visit(value);
			}
		}
	};
	visit(tree);
	if (tree.type === 'Program') {
		for (const node of tree.body) {
			if (node.type !== 'VariableDeclaration') {
				continue;
			}
			for (const d of node.declarations) {
				if (d.id.type === 'Identifier' && d.init?.type === 'ObjectExpression') {
					insert(d.id.end, ': Record<string, any>');
				}
			}
		}
	}
	return edits;
}

/**
 * @param {string} code - A text
 * @param {readonly Edit[]} edits - Replacements, in any order
 * @returns {string}
 */
function applyEdits(code, edits) {
	let out = code;
	for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
		out = `${out.slice(0, edit.start)}${edit.text}${out.slice(edit.end)}`;
	}
	return out;
}

/**
 * An expression of Pug code (plain JavaScript) with the types that `noImplicitAny` asks
 * for: the parameters of its functions are `any` (`(item) =>` becomes `(item: any) =>`,
 * `x =>` becomes `(x: any) =>`, `({ a }) =>` becomes `({ a }: any) =>`, `(a = 1) =>`
 * becomes `(a: any = 1) =>`, `(...r) =>` becomes `(...r: any[]) =>`). A text that is not an
 * expression is returned as it is.
 * @param {string} code - JavaScript
 * @param {Parser} acorn - The parser
 * @returns {string} TypeScript
 * @example
 * typedExpression('items.map((a, i) => a + i).filter(x => x)', acorn);
 * // 'items.map((a: any, i: any) => a + i).filter((x: any) => x)'
 */
export function typedExpression(code, acorn) {
	let node;
	try {
		node = acorn.parseExpressionAt(code, 0, { ecmaVersion: 'latest' });
	} catch {
		return code;
	}
	if (node.end !== code.trimEnd().length) {
		return code;
	}
	return applyEdits(code, typeEdits(code, node));
}

/**
 * The statements of Pug code (plain JavaScript) with the types that `noImplicitAny` asks
 * for: those of {@link typedExpression}, and the constants that an object literal
 * initialises are `Record<string, any>` (`const a = { b: 1 }` becomes
 * `const a: Record<string, any> = { b: 1 }`).
 * @param {string} code - JavaScript
 * @param {any} program - Its syntax tree (acorn)
 * @returns {string} TypeScript
 * @example
 * typedProgram('const a = { b: 1 };', acorn.parse('const a = { b: 1 };', { ecmaVersion: 'latest' }));
 * // 'const a: Record<string, any> = { b: 1 };'
 */
export function typedProgram(code, program) {
	return applyEdits(code, typeEdits(code, program));
}

/**
 * The text of a `script.` or `style.` block of Pug, from its text nodes. The line breaks of
 * such a block are nodes of their own (`a;`, `\n`, `b;`), so the values are joined as they
 * are: a line break written between them would make three of each.
 * @param {readonly { val: string }[]} nodes - The text nodes of the block
 * @returns {string}
 * @example
 * blockText([{ val: 'a;' }, { val: '\n' }, { val: 'b;' }]); // 'a;\nb;'
 */
export function blockText(nodes) {
	return nodes.map((node) => node.val).join('');
}

/**
 * The module without the imports that nothing below uses: a page imports the mixins of a
 * file that it includes, and `noUnusedLocals` refuses what it does not call. A name counts
 * as used when it appears in the code outside the import lines (see
 * {@link isIdentifierUsed}). Only the forms that the converter writes are read:
 * `import { A, B } from '...';` and `import A from '...';`.
 * @param {string} text - The module
 * @returns {string}
 * @example
 * pruneUnusedImports("import { A, B } from './a.tsx';\nimport C from './c.tsx';\nconst x = A;");
 * // "import { A } from './a.tsx';\nconst x = A;"
 */
export function pruneUnusedImports(text) {
	const lines = text.split('\n');
	const code = lines.filter((line) => !line.startsWith('import ')).join('\n');
	/** @type {string[]} */
	const kept = [];
	for (const line of lines) {
		const named = /^import \{ (.+) \} from (.+);$/.exec(line);
		if (named) {
			const names = named[1].split(', ').filter((name) => isIdentifierUsed(code, name));
			if (names.length > 0) {
				kept.push(`import { ${names.join(', ')} } from ${named[2]};`);
			}
			continue;
		}
		const sole = /^import ([\w$]+) from .+;$/.exec(line);
		if (sole) {
			if (isIdentifierUsed(code, sole[1])) {
				kept.push(line);
			}
			continue;
		}
		kept.push(line);
	}
	return kept.join('\n');
}

/**
 * The expression with the `false` and the `null` of the branches of a condition
 * (`a ? "x" : false`, `a ? "x" : null`) written as `undefined`. Only the branches of the
 * condition itself: a `false` inside a call or an operator is another value (`a && "x"` is
 * left as it is). Pug leaves out an attribute whose value is `false` or `null` as it does
 * for `undefined`, and the types of a text prop take `undefined` only. For a boolean prop
 * (`keepFalse`) the `false` means something and stays: React writes neither a `null` nor an
 * `undefined`, so that one is still changed.
 * @param {string} source - An expression of JavaScript
 * @param {Parser} acorn - The parser
 * @param {{ keepFalse?: boolean }} [options] - `keepFalse`: leave the `false` as it is
 * @returns {string}
 * @example
 * omittedBranchesToUndefined('lang === "en" ? "_blank" : false', acorn);
 * // 'lang === "en" ? "_blank" : undefined'
 * omittedBranchesToUndefined('opens ? "noopener" : null', acorn);
 * // 'opens ? "noopener" : undefined'
 * omittedBranchesToUndefined('on ? "true" : false', acorn, { keepFalse: true });
 * // 'on ? "true" : false'
 */
export function omittedBranchesToUndefined(source, acorn, { keepFalse = false } = {}) {
	let node;
	try {
		node = acorn.parseExpressionAt(`(${source})`, 0, { ecmaVersion: 'latest' });
	} catch {
		return source;
	}
	/** @type {{ start: number; end: number }[]} */
	const literals = [];
	/** @param {any} n */
	const visit = (n) => {
		if (n.type !== 'ConditionalExpression') {
			return;
		}
		for (const branch of [n.consequent, n.alternate]) {
			// The `value` of a regular expression literal that the parser does not support is
			// `null` too: the text of the literal (`raw`) tells a `null` from it.
			if (
				branch.type === 'Literal' &&
				((!keepFalse && branch.value === false) || branch.raw === 'null')
			) {
				literals.push(branch);
			} else {
				visit(branch);
			}
		}
	};
	visit(node);
	let out = `(${source})`;
	for (const literal of literals.toSorted((a, b) => b.start - a.start)) {
		out = `${out.slice(0, literal.start)}undefined${out.slice(literal.end)}`;
	}
	return out.slice(1, -1);
}

/**
 * The keys that an object literal sets for certain (`{ lang, a: 1 }`). A spread inside, a
 * computed key, or anything that is not an object literal: none, as what it sets is not
 * known.
 * @param {string} source - An expression of JavaScript
 * @param {Parser} acorn - The parser
 * @returns {string[]}
 * @example
 * literalKeys('{ lang, a: 1 }', acorn); // ['lang', 'a']
 */
export function literalKeys(source, acorn) {
	let node;
	try {
		node = acorn.parseExpressionAt(`(${source})`, 0, { ecmaVersion: 'latest' });
	} catch {
		return [];
	}
	if (node.type !== 'ObjectExpression') {
		return [];
	}
	/** @type {string[]} */
	const keys = [];
	for (const p of node.properties) {
		if (p.type !== 'Property' || p.computed) {
			return [];
		}
		keys.push(p.key.type === 'Identifier' ? p.key.name : String(p.key.value));
	}
	return keys;
}

/**
 * The declaration file of what the converted pages use and `@types/react` does not have:
 * `static` of `<html static>` (a kamado extension) and `command` / `commandfor` (Invoker
 * Commands). The package ships no types of its own: the pages get these where they are. A
 * `@types/react` that has them itself would make the two declarations clash: delete the
 * file then.
 * @returns {string}
 * @example
 * jsxDeclarations().includes('commandfor'); // true
 */
export function jsxDeclarations() {
	return `// Types of what the converted pages use and @types/react does not have.
// If a later @types/react declares them itself, delete the clashing members.
import 'react';

declare module 'react' {
	// Invoker Commands: \`<button command="show-modal" commandfor="id">\`.
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	interface HTMLAttributes<T> {
		command?: string | undefined;
		commandfor?: string | undefined;
	}

	// kamado: \`<html static>\` writes the page in the order of the template.
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	interface HtmlHTMLAttributes<T> {
		static?: boolean | undefined;
	}
}
`;
}
