/**
 * Writes the golden cases of `kd_css`: the hand-written style sheets of
 * `css-golden-cases.mjs` and what cssnano (kamado v2's options) makes of
 * them, as `crates/kd_css/tests/golden/<n>.in` / `.out` (`__ERROR__` for an
 * input cssnano rejects). Run it when cssnano is upgraded:
 * `node scripts/generate-css-golden.mjs`.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { cssnanoMinify } from './css-oracle.mjs';
import { cssCases } from './css-golden-cases.mjs';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'crates', 'kd_css', 'tests', 'golden');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const cases = cssCases();
let errors = 0;
for (const [n, input] of cases.entries()) {
	let expected;
	try {
		expected = await cssnanoMinify(input);
	} catch {
		expected = '__ERROR__';
		errors++;
	}
	writeFileSync(path.join(outDir, `${n}.in`), input);
	writeFileSync(path.join(outDir, `${n}.out`), expected);
}
process.stdout.write(
	`wrote ${cases.length} cases (${errors} rejected) to ${path.relative(root, outDir)}\n`,
);
