import type { Rule } from 'eslint';

import { attributeName, isHostElement, type Loose } from '../helpers.js';

/** The message of each prop that is left out. */
const MESSAGES: Readonly<
	Record<string, 'noIgnoredRef' | 'noIgnoredHydration' | 'noIgnoredContentEditable'>
> = {
	ref: 'noIgnoredRef',
	suppressHydrationWarning: 'noIgnoredHydration',
	suppressContentEditableWarning: 'noIgnoredContentEditable',
};

/**
 * Props that kamado reads and leaves out of the HTML. `ref` holds an element for code that
 * runs in the browser, and `suppressHydrationWarning` and `suppressContentEditableWarning`
 * quiet the warnings of a hydration that does not happen. Written on an HTML element they do
 * nothing; written on a component they are props like the rest (`key` is not one of these:
 * it names the items of a list).
 *
 * Why these three: they come with code written for the browser, and the runtime reads and
 * drops all three (RFC §7.1). The props that it writes (`defaultValue`, `defaultChecked`)
 * are not here: they mean something in the HTML.
 */
export const noIgnoredProps: Rule.RuleModule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Disallow ref, suppressHydrationWarning and suppressContentEditableWarning on HTML elements: kamado has no client to use them',
		},
		messages: {
			noIgnoredRef:
				'"ref" does nothing in kamado: the page is rendered once to HTML, and there is no client code to hold the element. Remove it.',
			noIgnoredHydration:
				'"suppressHydrationWarning" does nothing in kamado: nothing is hydrated. Remove it.',
			noIgnoredContentEditable:
				'"suppressContentEditableWarning" does nothing in kamado: nothing is hydrated, and no client code edits the element. Remove it.',
		},
		schema: [],
	},
	create(context) {
		return {
			JSXAttribute(node: Rule.Node) {
				const attribute = node as unknown as Loose;
				const name = attributeName(attribute);
				const messageId =
					name === undefined
						? undefined
						: Object.hasOwn(MESSAGES, name)
							? MESSAGES[name]
							: undefined;
				if (messageId && isHostElement(attribute.parent as Loose)) {
					context.report({ node, messageId });
				}
			},
		};
	},
};
