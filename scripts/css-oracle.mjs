/**
 * The oracle of `kd_css`: cssnano with the options kamado v2's style compiler
 * passed (`default` preset, comments kept when they start with `!`, no
 * declaration sorting). Used by the corpus, golden and check scripts.
 *
 * Run `node scripts/css-oracle.mjs 'a { color : #FFFFFF }'` to see what it
 * makes of a snippet.
 */
import { pathToFileURL } from 'node:url';

import cssnano from 'cssnano';
import postcss from 'postcss';

const processor = postcss([
	cssnano({
		preset: [
			'default',
			{
				discardComments: { removeAll: false, removeAllButFirst: false },
				cssDeclarationSorter: false,
			},
		],
	}),
]);

/**
 * Minifies CSS the way kamado v2's style compiler did.
 * @param {string} css - The style sheet
 * @returns {Promise<string>} The minified style sheet
 */
export async function cssnanoMinify(css) {
	const result = await processor.process(css, { from: undefined });
	return result.css;
}

/**
 * The style rules that have a rule or an at-rule inside (`a{color:red;&:hover{…}}`)
 * and the blocks that stand inside a style rule (`a{&:hover{…}}`,
 * `a{@media x{…}}`): the places where cssnano does less than it does elsewhere
 * (it converts some values and leaves others, expands a shorthand it changed
 * and merges nothing back: `border:2px none rgb(1 2 3/1)` becomes three
 * longhands), so one block has different spellings in its output depending on
 * how it was written.
 * @param {import('postcss').Root} root - A parsed style sheet
 * @returns {import('postcss').Container[]} The containers
 */
function nestedContainers(root) {
	/** @type {import('postcss').Container[]} */
	const found = [];
	root.walk((node) => {
		if ((node.type !== 'rule' && node.type !== 'atrule') || !node.nodes) {
			return;
		}
		let nested =
			node.type === 'rule' &&
			node.nodes.some((n) => n.type === 'rule' || n.type === 'atrule');
		for (let parent = node.parent; !nested && parent; parent = parent.parent) {
			nested = parent.type === 'rule';
		}
		if (nested) {
			found.push(node);
		}
	});
	return found;
}

/**
 * Minifies the declarations in {@link nestedContainers} the way cssnano
 * minifies them at the top level, so that two spellings of the same block can
 * be compared by their values.
 * @param {string} css - A style sheet (cssnano's output)
 * @returns {Promise<string>} The style sheet with those declarations minified
 * @example
 * await minifyNestedDeclarations('a{@media x{color:RED}}'); // 'a{@media x{color:red}}'
 */
export async function minifyNestedDeclarations(css) {
	const root = postcss.parse(css);
	const jobs = nestedContainers(root).flatMap((container) => {
		const declarations = container.nodes.filter((n) => n.type === 'decl');
		return declarations.length === 0
			? []
			: [{ container, declarations, first: container.nodes.indexOf(declarations[0]) }];
	});
	const minified = await Promise.all(
		jobs.map(({ declarations }) =>
			cssnanoMinify(`x{${declarations.map((d) => d.toString()).join(';')}}`),
		),
	);
	for (const [i, { container, declarations, first }] of jobs.entries()) {
		const rule = postcss.parse(minified[i]).first;
		// What cssnano gives back no rule for (it removed every declaration) stays as it is:
		// replacing it by nothing would make any two such blocks compare equal.
		if (rule?.type !== 'rule') {
			continue;
		}
		for (const d of declarations) {
			d.remove();
		}
		container.insertBefore(
			first,
			rule.nodes.map((d) => {
				const copy = d.clone();
				copy.raws.before = '';
				return copy;
			}),
		);
	}
	return root.toString();
}

/**
 * Replaces each run of declarations in {@link nestedContainers} by one
 * `/*d*\/` marker, keeping the structure (selectors, at-rules, nesting) and
 * where in it declarations are, but not what they say. For what
 * {@link minifyNestedDeclarations} cannot bring to one form (a shorthand that
 * cssnano expanded into longhands it does not merge, an invalid value it
 * leaves alone): there cssnano is no oracle for the values. `kd_css` minifies
 * them like the declarations anywhere else, which the rest of a corpus checks.
 * @param {string} css - A style sheet (cssnano's output)
 * @returns {string} The style sheet with the markers
 * @example
 * withoutNestedDeclarations('a{b:c;&:hover{d:e;f:g}h:i}'); // 'a{/*d*\/&:hover{/*d*\/}/*d*\/}'
 */
export function withoutNestedDeclarations(css) {
	const root = postcss.parse(css);
	for (const container of nestedContainers(root)) {
		// Collect the runs first and change the nodes after: replacing and
		// removing while walking the children skips the ones after.
		/** @type {{ first: import('postcss').ChildNode, rest: import('postcss').ChildNode[] }[]} */
		const runs = [];
		let run;
		for (const child of container.nodes) {
			if (child.type === 'decl') {
				if (run) {
					run.rest.push(child);
				} else {
					run = { first: child, rest: [] };
					runs.push(run);
				}
			} else if (child.type !== 'comment') {
				run = undefined;
			}
		}
		for (const { first, rest } of runs) {
			first.replaceWith(postcss.comment({ text: 'd', raws: { left: '', right: '' } }));
			for (const d of rest) {
				d.remove();
			}
		}
	}
	return root.toString();
}

/**
 * Whether cssnano's output for the input matches what cssnano makes of the
 * output of kd_css with the decisions it records undone (`undone` of
 * `crates/kd_css/examples/minify.rs`), compared as `check-css.mjs` compares
 * cssnano's minification of the output itself: as it is, then with the
 * declarations of rules with nested rules minified alike. A decision can be
 * one where cssnano changes the meaning (it makes an invalid declaration
 * valid), so that cssnano does not bring the output of kd_css and the input to
 * one. The comparison with the nested declarations replaced by markers is not
 * made: it does not compare their values, and a file it matches is not one
 * that differs by the decisions only.
 * @param {readonly string[]} expected - cssnano's output for the input, and
 * the other spellings of it to compare with (`check-css.mjs` adds the one with
 * neighbouring blocks joined)
 * @param {string} undone - kd_css's output with the decisions undone
 * @param {(a: string, b: string) => boolean} same - Whether two minified style
 * sheets are the same, with the leftovers `check-css.mjs` knows undone
 * @returns {Promise<{ matches: boolean, error?: string }>} `error` when
 * cssnano rejects `undone`
 * @example
 * await matchesWithDecisionsUndone(['a{b:0}'], 'a{b:0px}', (a, b) => a === b);
 * // { matches: true }
 */
export async function matchesWithDecisionsUndone(expected, undone, same) {
	let min;
	try {
		min = await cssnanoMinify(undone);
	} catch (error) {
		return {
			matches: false,
			error: (error instanceof Error ? error.message : String(error)).split('\n')[0],
		};
	}
	const minNested = await minifyNestedDeclarations(min);
	for (const theirs of expected) {
		if (same(theirs, min) || same(await minifyNestedDeclarations(theirs), minNested)) {
			return { matches: true };
		}
	}
	return { matches: false };
}

/**
 * Parses CSS with postcss and reports whether it is accepted.
 * @param {string} css - The style sheet
 * @returns {string | null} The error message, or null when it parses
 */
export function postcssError(css) {
	try {
		postcss.parse(css);
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	for (const css of process.argv.slice(2)) {
		process.stdout.write(`${await cssnanoMinify(css)}\n`);
	}
}
