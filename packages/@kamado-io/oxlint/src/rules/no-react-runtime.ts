import type { Rule } from 'eslint';

import { referencedModule } from '../helpers.js';

/**
 * Whether a specifier names React or React DOM, or a file of either (`react/jsx-runtime`).
 * The test is on the name of the package: `react-router` is another package.
 * @param specifier - The text of the `import`
 * @returns Whether the module is React
 */
function isReact(specifier: string): boolean {
	return /^react(?:-dom)?(?:\/|$)/.test(specifier);
}

/**
 * kamado does not run React. A page is rendered once, to HTML, by its own runtime, which
 * has no hooks, no context and no refs: a value that comes from `react` is a function
 * that fails when the page is rendered, so it is better to fail when the file is linted.
 * Types are not values, and `@types/react` stays what types the JSX.
 *
 * Why not leave it to the build: the error of the build is the one of React ("Invalid hook
 * call") or of Node ("Cannot find package"), and neither says that the page can have no state.
 */
export const noReactRuntime: Rule.RuleModule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Disallow importing values from react and react-dom: kamado does not run React',
		},
		messages: {
			noReactRuntime:
				'kamado does not run React: hooks, Context and Suspense do not work in a page, which is rendered once to HTML. Remove this import (`import type` is fine for a type; use `<>` for a fragment).',
		},
		schema: [],
	},
	create(context) {
		const check = (node: Rule.Node) => {
			const specifier = referencedModule(node);
			if (specifier !== undefined && isReact(specifier)) {
				context.report({ node, messageId: 'noReactRuntime' });
			}
		};
		return {
			ImportDeclaration: check,
			ExportNamedDeclaration: check,
			ExportAllDeclaration: check,
			ImportExpression: check,
			TSImportEqualsDeclaration: check,
			CallExpression: check,
		};
	},
};
