/**
 * Differential test input for `kd_html::minify`: random broken HTML (the
 * generator of the parser fuzzing) run through v2's chain up to the
 * minifier (linkedom, doctype, prettier), and what html-minifier-terser makes
 * of that with v2's options. `minifyCSS` / `minifyJS` are off here: the code
 * minifiers are compared on their own. Written as `<n>.in` (the text the
 * minifier receives) and `<n>.out` for the ignored Rust test
 * `crates/kd_html/tests/minify_differential.rs`:
 *
 * ```sh
 * node scripts/fuzz-html-minify.mjs /tmp/kd-minify 5000 1
 * KD_MINIFY_DIR=/tmp/kd-minify cargo test --release -p kd_html --test minify_differential -- --ignored
 * ```
 *
 * With a fourth argument `raw` the broken HTML goes to the minifier as it
 * is, which exercises the minifier's own parser quirks (v2 never feeds it
 * that). Inputs that the minifier rejects are stored as `__ERROR__`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createInputGenerator } from './html-fuzz.mjs';
import { v2Layout, v2Minify } from './v2-print.mjs';

const [outDirArg, countArg = '1000', seedArg = '1', rawArg] = process.argv.slice(2);
if (!outDirArg) {
	process.stderr.write('usage: fuzz-html-minify.mjs <outDir> [count] [seed] [raw]\n');
	process.exit(2);
}
const outDir = path.resolve(outDirArg);
const nextInput = createInputGenerator(Number(seedArg));

mkdirSync(outDir, { recursive: true });
let written = 0;
let errors = 0;
for (let n = 0; n < Number(countArg); n++) {
	const input = nextInput();
	let layout = input;
	if (rawArg !== 'raw') {
		try {
			layout = await v2Layout(input);
		} catch {
			continue;
		}
	}
	let expected;
	try {
		expected = await v2Minify(layout);
	} catch {
		expected = '__ERROR__';
		errors++;
	}
	writeFileSync(path.join(outDir, `${written}.in`), layout);
	writeFileSync(path.join(outDir, `${written}.out`), expected);
	written++;
}
process.stdout.write(`wrote ${written} cases (${errors} rejected) to ${outDir}\n`);
