import type { Rule } from 'eslint';

import { type Loose, type Node } from '../helpers.js';

const FUNCTIONS = new Set([
	'FunctionDeclaration',
	'FunctionExpression',
	'ArrowFunctionExpression',
]);

/** The nodes that hold the value of an expression without being it. */
const WRAPPERS = new Set([
	'ParenthesizedExpression',
	'TSAsExpression',
	'TSSatisfiesExpression',
	'TSNonNullExpression',
	'TSTypeAssertion',
]);

/**
 * Whether an expression is JSX, or can be: the branches of a condition and of `&&`, `||`
 * and `??` are looked at, and so is the last of a sequence.
 * @param expression - An expression
 * @returns Whether the value can be an element
 */
function isJsx(expression: Loose | null | undefined): boolean {
	if (!expression) {
		return false;
	}
	switch (expression.type) {
		case 'JSXElement':
		case 'JSXFragment': {
			return true;
		}
		case 'ConditionalExpression': {
			return (
				isJsx(expression.consequent as Loose) || isJsx(expression.alternate as Loose)
			);
		}
		case 'LogicalExpression': {
			return isJsx(expression.left as Loose) || isJsx(expression.right as Loose);
		}
		case 'SequenceExpression': {
			return isJsx((expression.expressions as readonly Loose[]).at(-1));
		}
		default: {
			return WRAPPERS.has(expression.type) && isJsx(expression.expression as Loose);
		}
	}
}

/**
 * A component is called while its page is rendered, and what it returns is written. An
 * `async` function returns a Promise, which is no element: kamado renders without waiting
 * (as React's `renderToStaticMarkup` does), so the page fails when it is rendered.
 *
 * A function is a component when it returns JSX, or when it is what a file exports as its
 * default (the page). Other `async` functions (a loader, a helper) are not components.
 */
export const noAsyncComponent: Rule.RuleModule = {
	meta: {
		type: 'problem',
		docs: {
			description: 'Disallow async components: kamado renders a page without waiting',
		},
		messages: {
			noAsyncComponent:
				'A component cannot be async: kamado renders a page synchronously, and a Promise is not an element. Remove "async", and get the data before the render (put it in a file of data.dir).',
		},
		schema: [],
	},
	create(context) {
		const { sourceCode } = context;
		/** The functions that are being read, innermost last, and whether each returns JSX. */
		const stack: { readonly node: Node; returnsJsx: boolean }[] = [];
		const reported = new Set<Node>();

		const report = (node: Node) => {
			if (!reported.has(node)) {
				reported.add(node);
				context.report({ node, messageId: 'noAsyncComponent' });
			}
		};
		/**
		 * Reports the function that a name stands for when it is `async`: the page that a file
		 * exports by name. A name that is imported has no function in this file, and is let through.
		 * @param from - The export that names it
		 * @param name - The name
		 */
		const reportIfAsync = (from: Node, name: string) => {
			let scope = sourceCode.getScope(from);
			while (scope.upper && !scope.set.has(name)) {
				scope = scope.upper;
			}
			const definition = scope.set.get(name)?.defs[0]?.node as unknown as
				Loose | undefined;
			const fn =
				definition?.type === 'VariableDeclarator'
					? (definition.init as Loose | null)
					: definition;
			if (fn && FUNCTIONS.has(fn.type) && fn.async === true) {
				report(fn as unknown as Node);
			}
		};
		const enter = (node: Node) => {
			const loose = node as unknown as Loose;
			const body = loose.body as Loose;
			stack.push({
				node,
				returnsJsx:
					loose.type === 'ArrowFunctionExpression' &&
					body.type !== 'BlockStatement' &&
					isJsx(body),
			});
		};
		const exit = () => {
			const frame = stack.pop();
			if (frame && (frame.node as unknown as Loose).async === true && frame.returnsJsx) {
				report(frame.node);
			}
		};

		return {
			FunctionDeclaration: enter,
			'FunctionDeclaration:exit': exit,
			FunctionExpression: enter,
			'FunctionExpression:exit': exit,
			ArrowFunctionExpression: enter,
			'ArrowFunctionExpression:exit': exit,
			ReturnStatement(node) {
				const frame = stack.at(-1);
				const argument = (node as unknown as Loose).argument as Loose | null;
				if (frame && isJsx(argument)) {
					frame.returnsJsx = true;
				}
			},
			ExportDefaultDeclaration(node) {
				const declaration = (node as unknown as Loose).declaration as Loose;
				if (FUNCTIONS.has(declaration.type) && declaration.async === true) {
					report(declaration as unknown as Node);
				} else if (declaration.type === 'Identifier') {
					// `export default Page;`, with `Page` declared above.
					reportIfAsync(node, declaration.name as string);
				}
			},
			ExportNamedDeclaration(node) {
				const { source, specifiers } = node as unknown as {
					source: unknown;
					specifiers: readonly { exported: Loose; local: Loose }[];
				};
				if (source) {
					return;
				}
				for (const { exported, local } of specifiers) {
					// `export { Page as default }`; the name is an identifier or a string.
					const name = exported.type === 'Identifier' ? exported.name : exported.value;
					if (name === 'default' && local.type === 'Identifier') {
						reportIfAsync(node, local.name as string);
					}
				}
			},
		};
	},
};
