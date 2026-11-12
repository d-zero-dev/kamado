/**
 * What the rules share: where a module is named, which scope a name lives in, and the few
 * shapes of JSX that ESTree has no types for.
 *
 * Nodes are read through loose types on purpose: the plugin runs in oxlint and in ESLint,
 * and neither of the two hands over a type that names the JSX and TypeScript nodes. When
 * `eslint` ships types for them (or oxlint does), the loose reads can become typed ones.
 */
import type { Rule, Scope } from 'eslint';

/** A node of the tree that either linter hands to a rule. */
export type Node = Rule.Node;

/** A node that is read by its `type` and the keys that the rule knows it has. */
export interface Loose {
	readonly type: string;
	readonly [key: string]: unknown;
}

/**
 * The text of a node that is a string literal, or a template literal without a hole.
 * @param node - Any node, or nothing
 * @returns The text, or `undefined` when the node is not a text that is known beforehand
 */
export function textOf(node: Loose | null | undefined): string | undefined {
	if (!node) {
		return undefined;
	}
	if (node.type === 'Literal' && typeof node.value === 'string') {
		return node.value;
	}
	if (node.type === 'TemplateLiteral') {
		const quasis = node.quasis as readonly { value: { cooked?: string | null } }[];
		const expressions = node.expressions as readonly unknown[];
		if (expressions.length === 0 && quasis.length === 1) {
			return quasis[0]?.value.cooked ?? undefined;
		}
	}
	return undefined;
}

/**
 * The module that a statement or an expression names, for the statements that name one:
 * `import … from`, `export … from`, `import()` and `require()`. A statement that moves only
 * types (`import type`, `export type … from`) names no module at run time, so it names none.
 * @param node - Any node
 * @returns The text of the specifier, or `undefined` when the node names no module
 * @example
 * ```ts
 * // `import { a } from 'react'`  -> 'react'
 * // `import type { A } from 'react'` -> undefined
 * ```
 */
export function referencedModule(node: Node): string | undefined {
	const loose = node as unknown as Loose;
	switch (loose.type) {
		case 'ImportDeclaration': {
			if (loose.importKind === 'type') {
				return undefined;
			}
			const specifiers = loose.specifiers as readonly Loose[];
			if (specifiers.length > 0 && specifiers.every((s) => s.importKind === 'type')) {
				return undefined;
			}
			return textOf(loose.source as Loose);
		}
		case 'ExportNamedDeclaration':
		case 'ExportAllDeclaration': {
			if (loose.exportKind === 'type') {
				return undefined;
			}
			// `export { type A } from '…'` marks the types one by one.
			const specifiers = (loose.specifiers ?? []) as readonly Loose[];
			if (specifiers.length > 0 && specifiers.every((s) => s.exportKind === 'type')) {
				return undefined;
			}
			return textOf(loose.source as Loose | null);
		}
		case 'ImportExpression': {
			return textOf(loose.source as Loose);
		}
		case 'TSImportEqualsDeclaration': {
			// `import fs = require('fs')`; `import A = B.C` names no module.
			const reference = loose.moduleReference as Loose;
			return loose.importKind !== 'type' && reference.type === 'TSExternalModuleReference'
				? textOf(reference.expression as Loose)
				: undefined;
		}
		case 'CallExpression': {
			const callee = loose.callee as Loose;
			if (callee.type === 'Identifier' && callee.name === 'require') {
				return textOf((loose.arguments as readonly Loose[])[0]);
			}
			return undefined;
		}
		default: {
			return undefined;
		}
	}
}

/**
 * The innermost scope that runs when something is called: a function (or a method, or an
 * arrow function), and the initializer of a field of a class, which runs for each instance.
 * What is outside all of them runs once, when the module is loaded.
 * @param scope - The scope of a node
 * @returns The scope of the function that encloses the node, or `null` at the top of the module
 */
export function enclosingFunctionScope(scope: Scope.Scope | null): Scope.Scope | null {
	for (let current = scope; current; current = current.upper) {
		if (current.type === 'function' || current.type === 'class-field-initializer') {
			return current;
		}
	}
	return null;
}

/**
 * Whether a scope is inside a function, as opposed to the module itself: what runs there
 * runs when the function is called, not when the module is loaded.
 * @param scope - The scope of a node
 * @returns Whether a function encloses the scope, or is the scope
 */
export function isInFunction(scope: Scope.Scope | null): boolean {
	return enclosingFunctionScope(scope) !== null;
}

/**
 * The variable that an identifier at a place of the tree stands for.
 * @param sourceCode - The source code of the file
 * @param from - A node that contains the identifier
 * @param identifier - The identifier
 * @returns The variable; `null` when the name is not declared anywhere (a global of the
 *   environment); `undefined` when the scope has no reference for the identifier
 */
export function variableOf(
	sourceCode: Rule.RuleContext['sourceCode'],
	from: Node,
	identifier: Loose,
): Scope.Variable | null | undefined {
	for (
		let scope: Scope.Scope | null = sourceCode.getScope(from);
		scope;
		scope = scope.upper
	) {
		const reference = scope.references.find(
			(candidate) => (candidate.identifier as unknown) === identifier,
		);
		if (reference) {
			return reference.resolved;
		}
	}
	return undefined;
}

/**
 * Whether a variable is one that the file declares at its top level, which every render
 * in a thread shares: a `let`, `const`, function or class of the module, or an import.
 * What the environment declares (`Object`, `Map`) has no declaration in the file.
 * @param variable - A variable, or what `variableOf` did not find
 * @returns Whether it is declared at the top of the module
 */
export function isModuleVariable(variable: Scope.Variable | null | undefined): boolean {
	return (
		variable !== null &&
		variable !== undefined &&
		variable.defs.length > 0 &&
		(variable.scope.type === 'module' || variable.scope.type === 'global')
	);
}

/**
 * Whether a JSX element is a tag of HTML, SVG or a custom element, which kamado writes as
 * it is, and not a component, which is called. The name of a tag starts in lower case; a
 * name with a dot or a capital is a component.
 * @param opening - A `JSXOpeningElement`
 * @returns Whether the element is a host element
 */
export function isHostElement(opening: Loose): boolean {
	const name = opening.name as Loose;
	if (name.type === 'JSXNamespacedName') {
		return true;
	}
	return name.type === 'JSXIdentifier' && /^[a-z]/.test(name.name as string);
}

/**
 * The name of a JSX attribute, when it is a plain name (`onClick`, not `xlink:href`).
 * @param attribute - A `JSXAttribute`
 * @returns The name, or `undefined`
 */
export function attributeName(attribute: Loose): string | undefined {
	const name = attribute.name as Loose;
	return name.type === 'JSXIdentifier' ? (name.name as string) : undefined;
}
