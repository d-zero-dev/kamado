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
 * A page is rendered from its props, and an incremental build builds it again only when
 * one of the files it was built from has changed. What a component reads by itself is
 * not among them: a file that it opens, an address that it fetches, a command that it
 * runs, and what a module awaits as it is loaded. The output then goes stale, and nothing
 * says so.
 *
 * What a page needs from outside goes into a file of `data.dir`, where the build reads it
 * and knows when it changed, and arrives in the props.
 *
 * Why one rule for these (files, the network, commands, top-level `await`): they are one
 * problem with one cure, and a project that keeps some of its data files next to its pages
 * switches them off with one name. Their messages are four, so that each says what it found.
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
				'A page that reads files by itself is not rebuilt when they change, so its HTML goes stale. Put what it needs in a file of data.dir and read it from the props.',
			noFetch:
				'A page that reaches the network by itself is not rebuilt when the answer changes, and the network is not an input of a render. Fetch before the build, keep the result in a file of data.dir and read it from the props.',
			noChildProcess:
				'A page that runs a command by itself is not rebuilt when its output changes. Run it before the build, keep the result in a file of data.dir and read it from the props.',
			noTopLevelAwait:
				'A top-level await runs once, when the module is loaded, and the build does not see what it waited for. Remove it, and put the data in a file of data.dir.',
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
			CallExpression: checkModule,
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
				if (isGlobalFetchMember(node as unknown as Loose)) {
					context.report({ node, messageId: 'noFetch' });
				}
			},
			VariableDeclarator(node) {
				if (takesGlobalFetch(node as unknown as Loose)) {
					context.report({ node, messageId: 'noFetch' });
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
