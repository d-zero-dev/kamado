import type { Rule } from 'eslint';

import {
	isInFunction,
	type Loose,
	type Node,
	referencedModule,
	variableOf,
} from '../helpers.js';

/** The modules that read files. */
const FILE_MODULES = new Set([
	'fs',
	'node:fs',
	'fs/promises',
	'node:fs/promises',
	'fs-extra',
]);

/** The modules that reach the network. */
const NETWORK_MODULES = new Set([
	'http',
	'node:http',
	'https',
	'node:https',
	'axios',
	'undici',
]);

/** The modules that run a command. */
const PROCESS_MODULES = new Set(['child_process', 'node:child_process']);

/** The functions of the environment that reach the network, and what is said about them. */
const NETWORK_GLOBALS = new Set(['fetch', 'XMLHttpRequest']);

/** The objects that `fetch` is a member of: `globalThis.fetch`. */
const GLOBAL_OBJECTS = new Set(['global', 'globalThis', 'self', 'window']);

/**
 * Whether a node is `globalThis.fetch` and the like: the member `fetch` of the global
 * object, in any use (called, passed on, or kept).
 * @param node - A `MemberExpression`
 * @returns Whether it names the global `fetch`
 */
function isGlobalFetchMember(node: Loose): boolean {
	const object = node.object as Loose;
	const property = node.property as Loose;
	return (
		node.computed !== true &&
		object.type === 'Identifier' &&
		GLOBAL_OBJECTS.has(object.name as string) &&
		property.type === 'Identifier' &&
		property.name === 'fetch'
	);
}

/**
 * Whether a declaration takes `fetch` out of the global object: `const { fetch } = globalThis`.
 * @param node - A `VariableDeclarator`
 * @returns Whether it does
 */
function takesGlobalFetch(node: Loose): boolean {
	const init = node.init as Loose | null;
	const id = node.id as Loose;
	if (init?.type !== 'Identifier' || !GLOBAL_OBJECTS.has(init.name as string)) {
		return false;
	}
	return (
		id.type === 'ObjectPattern' &&
		(id.properties as readonly Loose[]).some((property) => {
			const key = property.key as Loose | undefined;
			return (
				property.type === 'Property' &&
				property.computed !== true &&
				key?.type === 'Identifier' &&
				key.name === 'fetch'
			);
		})
	);
}

/**
 * Whether a node is a global name that the file does not declare itself.
 * @param sourceCode - The source code of the file
 * @param node - An `Identifier`
 * @returns Whether it refers to the global
 */
function isGlobal(sourceCode: Rule.RuleContext['sourceCode'], node: Loose): boolean {
	const variable = variableOf(sourceCode, node as unknown as Node, node);
	// A global of the environment has no declaration in the file: not found at all, or found
	// among the globals with no definition (`Math`, `Date`).
	return variable === null || (variable !== undefined && variable.defs.length === 0);
}

/** What each global object reads that a page may not, and what is said about it. */
const UNTRACKED_MEMBERS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	process: { env: 'noEnvironment', argv: 'noEnvironment' },
	Date: { now: 'noTime' },
	performance: { now: 'noTime' },
	Math: { random: 'noRandom' },
	crypto: { randomUUID: 'noRandom', getRandomValues: 'noRandom' },
};

/**
 * Whether a node names the global `name`: the identifier itself, or `globalThis.<name>` and
 * the like (a name that the file declares itself is its own).
 * @param sourceCode - The source code of the file
 * @param node - An expression
 * @param name - The name of the global
 * @returns Whether it is the global
 */
function isGlobalNamed(
	sourceCode: Rule.RuleContext['sourceCode'],
	node: Loose,
	name: string,
): boolean {
	if (node.type === 'Identifier') {
		return node.name === name && isGlobal(sourceCode, node);
	}
	if (node.type === 'MemberExpression' && node.computed !== true) {
		const object = node.object as Loose;
		const property = node.property as Loose;
		return (
			object.type === 'Identifier' &&
			GLOBAL_OBJECTS.has(object.name as string) &&
			property.type === 'Identifier' &&
			property.name === name &&
			isGlobal(sourceCode, object)
		);
	}
	return false;
}

/**
 * The name of the property a member expression reads: `env` for `process.env` and for
 * `process['env']`.
 * @param node - A `MemberExpression`
 * @returns The name, or `undefined` for a computed property that is not a string
 */
function propertyName(node: Loose): string | undefined {
	const property = node.property as Loose;
	if (node.computed === true) {
		return property.type === 'Literal' && typeof property.value === 'string'
			? property.value
			: undefined;
	}
	return property.type === 'Identifier' ? (property.name as string) : undefined;
}

/**
 * The message for a member of a global that a page may not read (`process.env`,
 * `Date.now`, `Math.random`, `crypto.randomUUID`, `performance.now`).
 * @param sourceCode - The source code of the file
 * @param node - A `MemberExpression`
 * @returns The id of the message, or `undefined` when the member is not one of them
 */
function untrackedMember(
	sourceCode: Rule.RuleContext['sourceCode'],
	node: Loose,
): string | undefined {
	const name = propertyName(node);
	if (name === undefined) {
		return undefined;
	}
	for (const [object, members] of Object.entries(UNTRACKED_MEMBERS)) {
		const messageId = Object.hasOwn(members, name) ? members[name] : undefined;
		if (
			messageId !== undefined &&
			isGlobalNamed(sourceCode, node.object as Loose, object)
		) {
			return messageId;
		}
	}
	return undefined;
}

/**
 * The message for `const { random } = Math` and the like: the member is taken out of the
 * global, and used by a name that is not one any more.
 * @param sourceCode - The source code of the file
 * @param node - A `VariableDeclarator`
 * @returns The id of the message, or `undefined`
 */
function untrackedDestructuring(
	sourceCode: Rule.RuleContext['sourceCode'],
	node: Loose,
): string | undefined {
	const id = node.id as Loose;
	const init = node.init as Loose | null;
	if (id.type !== 'ObjectPattern' || init === null) {
		return undefined;
	}
	for (const [object, members] of Object.entries(UNTRACKED_MEMBERS)) {
		if (!isGlobalNamed(sourceCode, init, object)) {
			continue;
		}
		for (const property of id.properties as readonly Loose[]) {
			const key = property.key as Loose | undefined;
			if (
				property.type === 'Property' &&
				property.computed !== true &&
				key?.type === 'Identifier' &&
				Object.hasOwn(members, key.name as string)
			) {
				return members[key.name as string];
			}
		}
	}
	return undefined;
}

/**
 * A page is rendered from its props, and an incremental build builds it again only when
 * one of the files it was built from has changed. What a component reads by itself is
 * not among them: a file that it opens, an address that it fetches, a command that it
 * runs, an environment variable, the time, a random number, and what a module awaits as it
 * is loaded. The output then goes stale (or differs from one build to the next), and nothing
 * says so.
 *
 * What a page needs from outside goes into a data file that is a script in `data.dir`,
 * where the build runs it and knows when its value changed, and arrives in the props.
 *
 * Why one rule for these (files, the network, commands, the environment, the clock,
 * randomness, top-level `await`): they are one problem with one cure, and a project that
 * keeps some of its data files next to its pages switches them off with one name. Their
 * messages are separate, so that each says what it found.
 * `fetch` is found as a name and not as a call (`urls.map(fetch)`, `const f = fetch`); a
 * `fetch` that the file declares itself is its own.
 */
export const noUntrackedInput: Rule.RuleModule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Disallow reading files, the network, commands and top-level await in a page: an incremental build cannot see them',
		},
		messages: {
			noFileRead:
				'A page that reads files by itself is not rebuilt when they change, so its HTML goes stale. Read them in a data file (a script of data.dir, with the readFile it is given) and take the result from the props.',
			noFetch:
				'A page that reaches the network by itself is not rebuilt when the answer changes, and the network is not an input of a render. Fetch it in a data file (a script of data.dir) and take the result from the props.',
			noChildProcess:
				'A page that runs a command by itself is not rebuilt when its output changes. Run it in a data file (a script of data.dir) and take the result from the props.',
			noTopLevelAwait:
				'A top-level await runs once, when the module is loaded, and the build does not see what it waited for. Remove it, and wait in a data file (a script of data.dir) instead.',
			noEnvironment:
				'A page that reads the environment (an environment variable, the command line) by itself is not rebuilt when it changes. Read it in a data file (a script of data.dir) and take the result from the props.',
			noTime:
				'A page that reads the current time by itself gets a different HTML in every build, and the build cannot tell why. Read it in a data file (a script of data.dir) and take the result from the props.',
			noRandom:
				'A page that uses a random number gets a different HTML in every build. Make the number in a data file (a script of data.dir) and take it from the props.',
		},
		schema: [],
	},
	create(context) {
		const { sourceCode } = context;

		const checkModule = (node: Node) => {
			const specifier = referencedModule(node);
			if (specifier === undefined) {
				return;
			}
			if (FILE_MODULES.has(specifier)) {
				context.report({ node, messageId: 'noFileRead' });
			} else if (NETWORK_MODULES.has(specifier)) {
				context.report({ node, messageId: 'noFetch' });
			} else if (PROCESS_MODULES.has(specifier)) {
				context.report({ node, messageId: 'noChildProcess' });
			}
		};
		const checkTopLevelAwait = (node: Node) => {
			if (!isInFunction(sourceCode.getScope(node))) {
				context.report({ node, messageId: 'noTopLevelAwait' });
			}
		};

		return {
			ImportDeclaration: checkModule,
			ExportNamedDeclaration: checkModule,
			ExportAllDeclaration: checkModule,
			ImportExpression: checkModule,
			TSImportEqualsDeclaration: checkModule,
			CallExpression(node) {
				checkModule(node);
				// `Date()` without `new` is the current time as text.
				const callee = node.callee as unknown as Loose;
				if (
					callee.type === 'Identifier' &&
					callee.name === 'Date' &&
					isGlobal(sourceCode, callee)
				) {
					context.report({ node, messageId: 'noTime' });
				}
			},
			// `fetch` and `XMLHttpRequest` as names that nothing in the file declares: a name that
			// is declared (an import, a parameter, a function) has a variable, and one that is not
			// is a reference that has none.
			Identifier(node) {
				if (!NETWORK_GLOBALS.has(node.name)) {
					return;
				}
				// `type Fetch = typeof fetch` names the function and does not use it.
				if ((node.parent as unknown as Loose).type === 'TSTypeQuery') {
					return;
				}
				if (variableOf(sourceCode, node, node as unknown as Loose) === null) {
					context.report({ node, messageId: 'noFetch' });
				}
			},
			MemberExpression(node) {
				const member = node as unknown as Loose;
				if (isGlobalFetchMember(member)) {
					context.report({ node, messageId: 'noFetch' });
					return;
				}
				const messageId = untrackedMember(sourceCode, member);
				if (messageId !== undefined) {
					context.report({ node, messageId });
				}
			},
			// `new Date()` is now; `new Date(value)` is a conversion of what the page was given.
			NewExpression(node) {
				const callee = node.callee as unknown as Loose;
				if (
					callee.type === 'Identifier' &&
					callee.name === 'Date' &&
					node.arguments.length === 0 &&
					isGlobal(sourceCode, callee)
				) {
					context.report({ node, messageId: 'noTime' });
				}
			},
			VariableDeclarator(node) {
				const declarator = node as unknown as Loose;
				if (takesGlobalFetch(declarator)) {
					context.report({ node, messageId: 'noFetch' });
					return;
				}
				const messageId = untrackedDestructuring(sourceCode, declarator);
				if (messageId !== undefined) {
					context.report({ node, messageId });
				}
			},
			AwaitExpression: checkTopLevelAwait,
			ForOfStatement(node) {
				if (node.await) {
					checkTopLevelAwait(node);
				}
			},
		};
	},
};
