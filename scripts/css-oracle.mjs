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
