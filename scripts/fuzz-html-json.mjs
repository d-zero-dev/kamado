/**
 * Differential test input for the JSON formatting of `kd_html::print`: pages
 * whose `<script type="application/ld+json">` (and `importmap`, ...) holds
 * random JSON written with random line breaks and blank lines, and what
 * prettier makes of them. Same files and test as `fuzz-html-print.mjs`:
 *
 * ```sh
 * node scripts/fuzz-html-json.mjs /tmp/kd-json 3000 1
 * KD_PRINT_DIR=/tmp/kd-json cargo test --release -p kd_html --test print_differential -- --ignored
 * ```
 *
 * Input prettier cannot parse is kept in the corpus too: the printer must
 * leave it as written, as prettier does.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { prettierHtml } from './v2-print.mjs';

const [outDirArg, countArg = '1000', seedArg = '1'] = process.argv.slice(2);
if (!outDirArg) {
	process.stderr.write('usage: fuzz-html-json.mjs <outDir> [count] [seed]\n');
	process.exit(2);
}
const outDir = path.resolve(outDirArg);
const options = { useTabs: true, bracketSameLine: true };

/**
 * A small deterministic PRNG (mulberry32).
 * @param {number} seed - The seed
 * @returns {() => number} Numbers in [0, 1)
 */
function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d_2b_79_f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}
const random = rng(Number(seedArg));
/**
 * @template T
 * @param {readonly T[]} list - The choices
 * @returns {T} One of them
 */
const pick = (list) => list[Math.floor(random() * list.length)];
const chance = (p) => random() < p;
const below = (n) => Math.floor(random() * n);

const strings = [
	'"a"',
	'"hello world"',
	'""',
	'"日本語"',
	'"x\\"y"',
	'"a\\nb"',
	'"a\\/b"',
	'"tab\\there"',
	'"\\u00e9"',
	"'single'",
	"'it\\'s'",
	'"it\'s"',
	'"https://example.com/?a=1&b=2"',
	'"<b>x</b>"',
	'"\\d"',
];
const numbers = [
	'0',
	'1',
	'-1',
	'1.5',
	'1.50',
	'1.0',
	'100',
	'1e3',
	'1E+3',
	'1e-3',
	'.5',
	'-0',
	'3.14159',
	'10.010',
	'0.0',
	'1e0',
	'2.50e10',
];

/**
 * @returns {string} Optional line break / indentation between tokens
 */
function gap() {
	return pick(['', '', '', ' ', '\n', '\n\t', '\n\n', '  \n  \n']);
}

/**
 * @param {number} depth - Nesting depth so far
 * @returns {string} A JSON-ish value
 */
function value(depth) {
	const r = random();
	if (depth > 3 || r < 0.35) {
		return pick([...strings, ...numbers, 'true', 'false', 'null']);
	}
	if (r < 0.7) {
		const n = below(5);
		let out = `{${gap()}`;
		for (let i = 0; i < n; i++) {
			const key = pick(['"a"', '"b-c"', '"@type"', '"k"', 'name', "'q'", '1', '"x y"']);
			out += `${key}${pick(['', ' '])}:${pick(['', ' ', '  '])}${value(depth + 1)}`;
			if (i < n - 1 || chance(0.1)) {
				out += `,${gap()}`;
			}
		}
		return `${out}${gap()}}`;
	}
	const n = below(5);
	let out = `[${gap()}`;
	for (let i = 0; i < n; i++) {
		out += value(depth + 1);
		if (i < n - 1 || chance(0.1)) {
			out += `,${gap()}`;
		}
	}
	return `${out}${gap()}]`;
}

mkdirSync(outDir, { recursive: true });
let written = 0;
for (let n = 0; n < Number(countArg); n++) {
	const type = pick([
		'application/ld+json',
		'application/json',
		'importmap',
		'speculationrules',
		'application/ld+json',
	]);
	const body = chance(0.05)
		? pick(['', '  ', '{', '{"a":1}{"b":2}', '{"a":1},', 'abc'])
		: value(0);
	const wrap = pick([
		(s) => `<script type="${type}">${s}</script>`,
		(s) => `<script type="${type}">\n${s}\n</script>`,
		(s) => `<div><script type="${type}">${s}</script></div>`,
		(s) => `<div>\n\t<script type="${type}">\n\t\t${s}\n\t</script>\n</div>`,
		(s) => `<html><head><script type="${type}">${s}</script></head><body></body></html>`,
	]);
	const input = wrap(body);
	let expected;
	try {
		expected = await prettierHtml(input, options);
	} catch {
		expected = '__ERROR__';
	}
	writeFileSync(path.join(outDir, `${written}.in`), input);
	writeFileSync(path.join(outDir, `${written}.out`), expected);
	written++;
}
writeFileSync(path.join(outDir, 'options.json'), JSON.stringify(options));
process.stdout.write(`wrote ${written} cases to ${outDir}\n`);
