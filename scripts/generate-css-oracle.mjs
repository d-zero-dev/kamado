/**
 * Writes the oracle output of a CSS corpus: for every `<n>.in` in the
 * directory, `<n>.out` is what cssnano (kamado v2's options, see
 * `css-oracle.mjs`) makes of it (`__ERROR__` when cssnano rejects the input).
 *
 * ```sh
 * node scripts/fuzz-css.mjs /tmp/css-corpus
 * node scripts/generate-css-oracle.mjs /tmp/css-corpus
 * ```
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { cssnanoMinify } from './css-oracle.mjs';

const dir = process.argv[2] ?? process.env.KD_CSS_DIR;
if (!dir) {
	throw new Error('usage: node scripts/generate-css-oracle.mjs <corpus directory>');
}
const names = readdirSync(dir)
	.filter((n) => n.endsWith('.in'))
	.map((n) => n.slice(0, -3))
	.toSorted((a, b) => Number(a) - Number(b));
let errors = 0;
for (const name of names) {
	const input = readFileSync(path.join(dir, `${name}.in`), 'utf8');
	let expected;
	try {
		expected = await cssnanoMinify(input);
	} catch {
		expected = '__ERROR__';
		errors++;
	}
	writeFileSync(path.join(dir, `${name}.out`), expected);
}
process.stdout.write(`wrote ${names.length} oracle outputs (${errors} rejected) to ${dir}\n`);
