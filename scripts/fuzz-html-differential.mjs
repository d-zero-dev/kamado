/**
 * Differential fuzzing input for `kd_html`: random HTML-ish strings, each with
 * the output v2 produced for it (`domSerialize` with a no-op hook, i.e.
 * linkedom). Written as `<n>.in` / `<n>.out` pairs into a directory that the
 * ignored Rust test `crates/kd_html/tests/differential.rs` reads:
 *
 * ```sh
 * node scripts/fuzz-html-differential.mjs /tmp/kd-fuzz 20000 1
 * KD_FUZZ_DIR=/tmp/kd-fuzz cargo test -p kd_html --test differential -- --ignored
 * ```
 *
 * The generator avoids the constructs on which v3 differs on purpose
 * (`<?...?>`, a doctype in the middle), so any difference is a real divergence.
 * The corpus is not committed: it is large and fully determined by the seed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { domSerialize } from '../packages/kamado/src/utils/dom.ts';

import { createInputGenerator } from './html-fuzz.mjs';

const [outDirArg, countArg = '5000', seedArg = '1'] = process.argv.slice(2);
if (!outDirArg) {
	process.stderr.write('usage: fuzz-html-differential.mjs <outDir> [count] [seed]\n');
	process.exit(2);
}
const outDir = path.resolve(outDirArg);
const count = Number(countArg);

const nextInput = createInputGenerator(Number(seedArg));

mkdirSync(outDir, { recursive: true });
let written = 0;
for (let n = 0; n < count; n++) {
	const input = nextInput();
	const expected = await domSerialize(input, { hook: () => {} }).catch(
		() => '__LINKEDOM_THREW__',
	);
	writeFileSync(path.join(outDir, `${n}.in`), input);
	writeFileSync(path.join(outDir, `${n}.out`), expected);
	written++;
}
process.stdout.write(`wrote ${written} cases to ${outDir}\n`);
