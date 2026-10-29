/**
 * Differential test input for the whole of v3's HTML path up to the
 * minifier: random broken HTML (the generator of the parser fuzzing), with
 * what v2 makes of it: linkedom's serialization, the `doctype` transform and
 * prettier. Written as `<n>.in` / `<n>.out` for the ignored Rust test
 * `crates/kd_html/tests/print_differential.rs` (set `KD_PRINT_PIPELINE=1` so
 * that the test parses and serializes the input first):
 *
 * ```sh
 * node scripts/fuzz-html-pipeline.mjs /tmp/kd-pipeline 5000 1
 * KD_PRINT_DIR=/tmp/kd-pipeline KD_PRINT_PIPELINE=1 cargo test --release -p kd_html --test print_differential -- --ignored
 * ```
 *
 * Inputs for which v2 fails (prettier throws on what linkedom produced) are
 * stored as `__ERROR__`: v3 must fail on them too. Pages with code (`<script>`,
 * `<style>`, `style` attributes, event handlers) that prettier formats are left
 * out: prettier formats the code and v3 does not (RFC §2).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createInputGenerator } from './html-fuzz.mjs';
import { addDoctype, hasCode, prettierHtml, v2Serialize } from './v2-print.mjs';

const [outDirArg, countArg = '1000', seedArg = '1', optionsArg = '{}'] =
	process.argv.slice(2);
if (!outDirArg) {
	process.stderr.write(
		'usage: fuzz-html-pipeline.mjs <outDir> [count] [seed] [optionsJson]\n',
	);
	process.exit(2);
}
const outDir = path.resolve(outDirArg);
const options = JSON.parse(optionsArg);
const nextInput = createInputGenerator(Number(seedArg));

mkdirSync(outDir, { recursive: true });
let written = 0;
let errors = 0;
let skipped = 0;
for (let n = 0; n < Number(countArg); n++) {
	const input = nextInput();
	let expected;
	try {
		// The steps of `v2Layout`, taken apart to look at the page: v3 does not
		// format the code in a page (RFC §2), v2 minified it right after prettier,
		// so the layout of the code is compared with the minifiers. A page that
		// prettier rejects stays whether it holds code or not: v3 fails on it too.
		const serialized = await v2Serialize(input);
		const formatted = await prettierHtml(addDoctype(serialized), options);
		if (hasCode(serialized)) {
			skipped++;
			continue;
		}
		expected = formatted;
	} catch {
		expected = '__ERROR__';
		errors++;
	}
	writeFileSync(path.join(outDir, `${written}.in`), input);
	writeFileSync(path.join(outDir, `${written}.out`), expected);
	written++;
}
writeFileSync(path.join(outDir, 'options.json'), JSON.stringify(options));
process.stdout.write(
	`wrote ${written} cases (${errors} that v2 rejects, ${skipped} skipped for code) to ${outDir}\n`,
);
