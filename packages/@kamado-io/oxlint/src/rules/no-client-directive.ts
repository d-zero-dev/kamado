import type { Rule } from 'eslint';

const DIRECTIVES = new Set(['use client', 'use server']);

/**
 * Every component of kamado is a server component, rendered once to HTML: there is no
 * client for a file to be handed to, so `'use client'` marks nothing. `'use server'` marks
 * the functions that a client calls on the server, and nobody does.
 *
 * Why an error, when React tolerates the directive: a file that says it is for the client
 * is read as if its hooks and handlers worked, and they do not.
 */
export const noClientDirective: Rule.RuleModule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				"Disallow the 'use client' and 'use server' directives: kamado has no client",
		},
		messages: {
			noClientDirective:
				'"{{directive}}" means nothing in kamado: every component is rendered once to HTML, with no client and no server to call. Remove it.',
		},
		schema: [],
	},
	create(context) {
		return {
			ExpressionStatement(node) {
				// Why `directive` and not the text of a string statement: a string that is not at the
				// top of a file or a function body is an expression (`'use client';` after other
				// code), which no tool reads as a directive. The parsers set `directive` on the
				// statements that really are.
				const { directive } = node as unknown as { directive?: string | null };
				if (directive && DIRECTIVES.has(directive)) {
					context.report({ node, messageId: 'noClientDirective', data: { directive } });
				}
			},
		};
	},
};
