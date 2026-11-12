import type { Rule, Scope } from 'eslint';

import {
	enclosingFunctionScope,
	isInFunction,
	isModuleVariable,
	type Loose,
	type Node,
	variableOf,
} from '../helpers.js';

/**
 * The methods of arrays, maps and sets that change the value they are called on.
 *
 * Why by name: the rule reads no types (oxlint has none to give), so a method of that name
 * on a variable of the file is taken as the write that it is on a collection. A variable of
 * the file that is another thing with the same name (`const d = dayjs(); d.add(1, 'day')`)
 * is a false positive, which is accepted. `delete` and `clear` are in because the state of a
 * `Map` or a `Set` is as much its entries as it is their number.
 */
const MUTATING_METHODS = new Set([
	'push',
	'pop',
	'shift',
	'unshift',
	'splice',
	'sort',
	'reverse',
	'fill',
	'copyWithin',
	'set',
	'add',
	'delete',
	'clear',
]);

/** The functions of `Object` and `Reflect` that change the first value they are given. */
const MUTATING_STATIC_FUNCTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
	Object: new Set(['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf']),
	Reflect: new Set(['set', 'defineProperty', 'deleteProperty', 'setPrototypeOf']),
};

/**
 * The iterations whose callback runs, to its end, at the place of the call: `ITEMS.forEach(…)`
 * at the top of a module fills a table as the module is loaded.
 */
const ITERATIONS = new Set([
	'forEach',
	'map',
	'filter',
	'reduce',
	'reduceRight',
	'flatMap',
	'some',
	'every',
	'find',
	'findIndex',
	'findLast',
	'findLastIndex',
	'sort',
	'toSorted',
]);

/** The nodes that hold the value of an expression without being it. */
const WRAPPERS = new Set([
	'ParenthesizedExpression',
	'ChainExpression',
	'TSAsExpression',
	'TSSatisfiesExpression',
	'TSNonNullExpression',
	'TSTypeAssertion',
]);

/**
 * The names that a pattern on the left of an assignment writes: the target itself, what is
 * inside `[a, b]` and `{ a, b: c }`, the default of `[a = 1]` and the rest of `[...a]`.
 * @param target - The left side of an assignment, or a part of it
 * @returns The expressions that are written (names and members)
 */
function writtenBy(target: Loose | null): Loose[] {
	if (!target) {
		return [];
	}
	switch (target.type) {
		case 'ArrayPattern': {
			return (target.elements as readonly (Loose | null)[]).flatMap((element) =>
				writtenBy(element),
			);
		}
		case 'ObjectPattern': {
			return (target.properties as readonly Loose[]).flatMap((property) =>
				writtenBy(property.type === 'RestElement' ? property : (property.value as Loose)),
			);
		}
		case 'AssignmentPattern': {
			return writtenBy(target.left as Loose);
		}
		case 'RestElement': {
			return writtenBy(target.argument as Loose);
		}
		default: {
			return [target];
		}
	}
}

/**
 * The name at the root of `a`, `a.b` and `a.b.c`: the variable that a write through the
 * member changes. TypeScript's `as`, `!` and `satisfies` and parentheses are looked through
 * (`(cache as Map<string, number>).set(…)`). A call, a `new` and the like have no such name.
 * @param expression - The target of a write
 * @returns The identifier, or `undefined`
 */
function rootOf(expression: Loose): Loose | undefined {
	let current = expression;
	for (;;) {
		if (current.type === 'MemberExpression') {
			current = current.object as Loose;
		} else if (WRAPPERS.has(current.type)) {
			current = current.expression as Loose;
		} else {
			break;
		}
	}
	return current.type === 'Identifier' ? current : undefined;
}

/**
 * Whether the function runs to its end as the module is loaded, and not for a render: one
 * that is called at once, and the callback of an iteration, at the top of the module.
 * Anything else that is passed on (`register(() => …)`) may be called later, by a render.
 * @param scope - The scope of the function that encloses a write
 * @returns Whether it is run at the place where it is written, at the top of the module
 */
function runsWhenLoaded(scope: Scope.Scope): boolean {
	if (scope.type !== 'function' || isInFunction(scope.upper)) {
		return false;
	}
	const fn = scope.block as unknown as Loose;
	const call = fn.parent as Loose | undefined;
	if (call?.type !== 'CallExpression') {
		return false;
	}
	if (call.callee === fn) {
		return true;
	}
	const callee = call.callee as Loose;
	const property = callee.property as Loose | undefined;
	return (
		(call.arguments as readonly Loose[]).includes(fn) &&
		callee.type === 'MemberExpression' &&
		callee.computed !== true &&
		property?.type === 'Identifier' &&
		ITERATIONS.has(property.name as string)
	);
}

/**
 * A component is called for each page, by the workers in turn, and they share nothing. A
 * variable of the module that a function changes is then a value that depends on which
 * page came before, and on which worker had it: the same site renders into different
 * HTML. `let`, an object whose key is set, an array that is pushed to and a `Map` that is
 * filled are all that.
 *
 * What the module does as it is loaded is not a render and is let through: a statement at
 * the top, a function that is called at once, and the callback of an iteration at the top
 * (the table that `ITEMS.forEach(…)` fills). So is everything that belongs to the function.
 *
 * The writes that are seen: an assignment (also through a pattern and a `for…of`), `++`,
 * `delete`, a method of a collection, and `Object.assign` and its kind. The values that are
 * imported are seen only by the writes that cannot be anything else (`config.a = 1`): a
 * method of that name can be the function of a library (`_.set(o, 'a', 1)`).
 *
 * Why not offer a helper for the memo: what is worth memoizing is computed from the props,
 * and the render of the next page may not see it.
 */
export const noModuleState: Rule.RuleModule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Disallow a function that changes a variable of the module: pages are rendered in parallel',
		},
		messages: {
			noModuleState:
				'"{{name}}" is a variable of the module, and a render must not change it: pages are rendered one after another in several threads, so the HTML would depend on the order. Keep the value inside the function, or compute it from the props.',
		},
		schema: [],
	},
	create(context) {
		const { sourceCode } = context;

		/**
		 * @param write - The expression that writes
		 * @param target - What it writes to
		 * @param byMethod - Whether the write is a call of a method such as `push` or `set`,
		 *   which is a write only when the object is a collection: what the file declares
		 *   is known to be one, what it imports is not (`_.set(o, 'a', 1)` of lodash).
		 */
		const check = (write: Node, target: Loose, byMethod = false) => {
			const identifier = rootOf(target);
			const scope = enclosingFunctionScope(sourceCode.getScope(write));
			if (!identifier || !scope || runsWhenLoaded(scope)) {
				return;
			}
			const variable = variableOf(sourceCode, write, identifier);
			if (byMethod && variable?.defs.some((def) => def.type === 'ImportBinding')) {
				return;
			}
			if (isModuleVariable(variable)) {
				context.report({
					node: write,
					messageId: 'noModuleState',
					data: { name: identifier.name as string },
				});
			}
		};

		/**
		 * The left side of `for (… of …)` and `for (… in …)`, when it is not a declaration: it is
		 * written for each round.
		 * @param node - The statement
		 */
		const checkLoop = (node: Node) => {
			const left = (node as unknown as Loose).left as Loose;
			if (left.type !== 'VariableDeclaration') {
				for (const target of writtenBy(left)) {
					check(node, target);
				}
			}
		};

		return {
			AssignmentExpression(node) {
				for (const target of writtenBy(node.left as unknown as Loose)) {
					check(node, target);
				}
			},
			UpdateExpression(node) {
				check(node, node.argument as unknown as Loose);
			},
			UnaryExpression(node) {
				if (node.operator === 'delete') {
					check(node, node.argument as unknown as Loose);
				}
			},
			ForInStatement: checkLoop,
			ForOfStatement: checkLoop,
			CallExpression(node) {
				const callee = node.callee as unknown as Loose;
				if (callee.type !== 'MemberExpression') {
					return;
				}
				const property = callee.property as Loose;
				const object = callee.object as Loose;
				// `list.push(1)`, and `list['push'](1)`.
				const method =
					callee.computed === true
						? typeof property.value === 'string'
							? property.value
							: undefined
						: property.type === 'Identifier'
							? (property.name as string)
							: undefined;
				if (method === undefined) {
					return;
				}
				if (
					callee.computed !== true &&
					object.type === 'Identifier' &&
					MUTATING_STATIC_FUNCTIONS[object.name as string]?.has(method)
				) {
					// `Object.assign(o, …)` and `Reflect.set(o, …)` write to their first argument; this
					// comes before the methods, because `set` is one of those too.
					const first = node.arguments[0] as unknown as Loose | undefined;
					if (first && first.type !== 'SpreadElement') {
						check(node, first);
					}
				} else if (MUTATING_METHODS.has(method)) {
					check(node, object, true);
				}
			},
		};
	},
};
