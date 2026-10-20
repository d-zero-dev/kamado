/**
 * Differential test input for the whole HTML chain of a v3 build: random
 * broken HTML (the generator of the parser fuzzing) and what v2 makes of it
 * with its default page transforms: linkedom's serialization, `doctype`,
 * prettier, `lineBreak`; and html-minifier-terser (code minifiers off, they
 * are compared on their own) when the fourth argument is `on`. v3's defaults
 * for the formatter are tabs and `bracketSameLine`, so prettier is called with
 * those. Written as `<n>.in` / `<n>.out` for the ignored test
 * `chain_matches_v2` in `crates/kd_core`, which runs v3 with `minify: false`:
 *
 * ```sh
 * node scripts/fuzz-html-chain.mjs /tmp/kd-chain 5000 1
 * KD_CHAIN_DIR=/tmp/kd-chain cargo test --release -p kd_core -- --ignored chain_matches_v2
 * ```
 *
 * For a corpus written with `on`, set `KD_CHAIN_MINIFY=on` as well: the test then
 * runs v3 with the minifier (code minifiers off).
 *
 * With `on`, the corpus is what v2 outputs with its minifier, which v3 matches
 * on well-formed pages but not on the broken ones that this generator makes:
 * v3 minifies the tree, where the minifier repaired the markup (a `<colgroup>`
 * around a bare `<col>`, unclosed elements). Use it to see how far apart the
 * two are, not as a test that has to pass.
 *
 * Inputs for which a v2 stage throws are stored as `__ERROR__`: with
 * `html.onError: "error"` v3 must fail on them too.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { domSerialize } from 'kamado-v2/utils/dom';

import { createInputGenerator } from './html-fuzz.mjs';
import { addDoctype, prettierHtml, v2Minify } from './v2-print.mjs';

const [outDirArg, countArg = '1000', seedArg = '1', minifyArg = 'off'] =
	process.argv.slice(2);
if (!outDirArg) {
	process.stderr.write('usage: fuzz-html-chain.mjs <outDir> [count] [seed] [off|on]\n');
	process.exit(2);
}
const withMinify = minifyArg === 'on';
const outDir = path.resolve(outDirArg);
const nextInput = createInputGenerator(Number(seedArg));

mkdirSync(outDir, { recursive: true });
let errors = 0;
let skipped = 0;
let written = 0;
const count = Number(countArg);
for (let n = 0; n < count; n++) {
	const input = nextInput();
	let expected;
	try {
		const serialized = await domSerialize(input, { hook: () => {} });
		// Prettier formats the code in `<script>`, `<style>`, `style` attributes
		// and event handlers, and v2 minified that code right afterwards. With
		// the code minifiers off here, such pages would only show prettier's
		// code layout, which is not what v2 outputs; the code is compared
		// together with the code minifiers.
		if (/<(?:script|style)\b|\sstyle=|\son[a-z]+=/i.test(serialized)) {
			skipped++;
			continue;
		}
		const formatted = await prettierHtml(addDoctype(serialized), {
			useTabs: true,
			bracketSameLine: true,
		});
		const minified = withMinify ? await v2Minify(formatted) : formatted;
		expected = minified.replaceAll(/\r?\n/g, '\n');
	} catch {
		expected = '__ERROR__';
		errors++;
	}
	writeFileSync(path.join(outDir, `${written}.in`), input);
	writeFileSync(path.join(outDir, `${written}.out`), expected);
	written++;
}
process.stdout.write(
	`wrote ${written} cases (${errors} rejected, ${skipped} skipped for code) to ${outDir}\n`,
);
