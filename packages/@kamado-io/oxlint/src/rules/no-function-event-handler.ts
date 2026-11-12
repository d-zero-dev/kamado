import type { Rule } from 'eslint';

import { attributeName, isHostElement, type Loose } from '../helpers.js';

/**
 * Whether an attribute is an event handler by the test of React and of the runtime of
 * kamado: `on` and at least one more character, in any case (`onClick`, `onclick`).
 * @param name - The name of the attribute
 * @returns Whether the name is the one of an event handler
 */
function isEventName(name: string): boolean {
	return /^on./i.test(name);
}

/**
 * Whether an expression is no function for sure, from its shape alone: a literal, a
 * template, `undefined` and `void 0`, a text that is put together with `+`, and a condition
 * whose two branches are such. A name, a call or a member can be a function, and kamado
 * cannot tell, so it is not let through.
 *
 * Why the false positives are accepted: the rule reads no types, and a miss is silent
 * (the handler is gone from the page), while a name that holds a text can be written as
 * the text in place.
 * @param expression - An expression
 * @returns Whether the value cannot be a function
 */
function isNotAFunctionExpression(expression: Loose): boolean {
	switch (expression.type) {
		case 'JSXEmptyExpression':
		case 'Literal':
		case 'TemplateLiteral': {
			return true;
		}
		case 'Identifier': {
			return expression.name === 'undefined';
		}
		case 'UnaryExpression': {
			return expression.operator === 'void';
		}
		case 'BinaryExpression': {
			return expression.operator === '+';
		}
		case 'ConditionalExpression': {
			return (
				isNotAFunctionExpression(expression.consequent as Loose) &&
				isNotAFunctionExpression(expression.alternate as Loose)
			);
		}
		default: {
			return false;
		}
	}
}

/**
 * Whether the value of an attribute is no function for sure: no value, a text, or an
 * expression that {@link isNotAFunctionExpression} lets through.
 * @param value - The `value` of a `JSXAttribute`
 * @returns Whether the value is a text or nothing
 */
function isNotAFunction(value: Loose | null): boolean {
	if (value === null || value.type === 'Literal') {
		return true;
	}
	if (value.type !== 'JSXExpressionContainer') {
		return false;
	}
	return isNotAFunctionExpression(value.expression as Loose);
}

/**
 * kamado renders a page once, to HTML, and sends no JavaScript with it. A function that is
 * given to the event handler of an HTML element has nothing to be attached to, and the
 * element is written without it, silently. A text is the one value that is written: in
 * `<html static>`, `onClick="go()"` is the attribute of the template that the page came from.
 *
 * Only the elements of HTML are looked at: a function that is given to a component
 * (`<List onRender={fn} />`) is an ordinary prop, which the component calls.
 *
 * Why an error and not a warning from the build: a page that is rendered in a worker
 * cannot be told apart from the one that is rendered next, and an element that is made
 * at the top of a module (`const B = <button onClick={fn} />`) is made before any page.
 * The source can be read without running anything.
 */
export const noFunctionEventHandler: Rule.RuleModule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Disallow a function as the event handler of an HTML element: kamado sends no JavaScript',
		},
		messages: {
			noFunctionEventHandler:
				'"{{name}}" is dropped from the HTML unless its value is a text: kamado renders each page once and sends no JavaScript, so a function has nothing to run it. Remove it, or write the text in place ("go()", inside <html static>).',
		},
		schema: [],
	},
	create(context) {
		return {
			JSXAttribute(node: Rule.Node) {
				const attribute = node as unknown as Loose;
				const name = attributeName(attribute);
				if (name === undefined || !isEventName(name)) {
					return;
				}
				if (!isHostElement(attribute.parent as Loose)) {
					return;
				}
				if (isNotAFunction(attribute.value as Loose | null)) {
					return;
				}
				context.report({ node, messageId: 'noFunctionEventHandler', data: { name } });
			},
		};
	},
};
