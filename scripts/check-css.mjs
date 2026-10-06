/**
 * Checks `kd_css::minify` against cssnano over a corpus (`<n>.in` and the
 * cssnano output `<n>.out`, see `fuzz-css.mjs` and `generate-css-oracle.mjs`):
 *
 * 1. the Rust output must parse with postcss,
 * 2. it must mean what the input meant: `cssnano(mine) === cssnano(original)`,
 *    compared as strings,
 * 3. it must not be larger than cssnano's output by more than 3 %,
 * 4. minifying it again must change nothing.
 *
 * ```sh
 * cargo build --release --offline -p kd_css --example minify
 * KD_CSS_DIR=/tmp/css-corpus node scripts/check-css.mjs
 * ```
 *
 * `KD_CSS_SHOW=<n>` shows that many mismatches (default 8); `KD_CSS_MODE`
 * is passed to the example (`declarations`, `media`) and turns the equivalence
 * check off (cssnano cannot read those). The exit code is 1 when a check
 * fails.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import { cssnanoMinify, postcssError } from './css-oracle.mjs';

const root = path.resolve(import.meta.dirname, '..');
const binary = path.join(root, 'target', 'release', 'examples', 'minify');
const dir = process.env.KD_CSS_DIR ?? process.argv[2];
if (!dir) {
	throw new Error('usage: KD_CSS_DIR=<corpus directory> node scripts/check-css.mjs');
}
const show = Number(process.env.KD_CSS_SHOW ?? 8);
const mode = process.env.KD_CSS_MODE ?? '';
const limit = 1.03;

const names = readdirSync(dir)
	.filter((n) => n.endsWith('.in'))
	.map((n) => n.slice(0, -3))
	.toSorted((a, b) => Number(a) - Number(b));

/**
 * Runs the Rust minifier over files.
 * @param {string[]} files - Paths
 * @returns {Map<string, string>} Output by path (`__ERROR__ ...` for errors)
 */
function runRust(files) {
	const run = spawnSync(binary, [], {
		input: `${files.join('\n')}\n`,
		encoding: 'utf8',
		maxBuffer: 1 << 30,
		env: { ...process.env, KD_CSS_MODE: mode },
	});
	if (run.status !== 0) {
		throw new Error(`minify example failed: ${run.stderr}`);
	}
	const out = new Map();
	for (const line of run.stdout.split('\n').filter(Boolean)) {
		const r = JSON.parse(line);
		out.set(r.path, r.error === undefined ? r.css : `__ERROR__ ${r.error}`);
	}
	return out;
}

/**
 * Shows where two strings differ, with a little context.
 * @param {string} theirs - cssnano's text
 * @param {string} mine - the other text
 * @returns {string} A one-line description
 */
function diffOf(theirs, mine) {
	let p = 0;
	while (p < theirs.length && p < mine.length && theirs[p] === mine[p]) {
		p++;
	}
	const window = (/** @type {string} */ text) =>
		JSON.stringify(text.slice(Math.max(0, p - 40), p + 50)).slice(1, -1);
	return `at ${p}: …${window(theirs)}…\n      vs …${window(mine)}…`;
}

/**
 * Joins neighbouring `@media` / `@supports` / `@container` blocks that have the
 * same query, so that two spellings of the same style sheet compare equal.
 * @param {string} css - A minified style sheet
 * @returns {string} The style sheet with the blocks joined
 */
function joinAdjacentAtRules(css) {
	let out = css;
	const start = /@(?:media|supports|container)[^{};]*\{/gu;
	let match = start.exec(out);
	while (match) {
		const header = match[0];
		let depth = 1;
		let i = match.index + header.length;
		while (i < out.length && depth > 0) {
			if (out[i] === '{') {
				depth++;
			} else if (out[i] === '}') {
				depth--;
			}
			i++;
		}
		// `i` is just after the closing brace of the block.
		if (depth === 0 && out.startsWith(header, i)) {
			out = out.slice(0, i - 1) + out.slice(i + header.length);
			start.lastIndex = match.index;
		}
		match = start.exec(out);
	}
	return out;
}

/**
 * Differences that are cssnano leaving something unminified that kd_css
 * minifies, each a pure formatting difference. A mismatch that disappears when
 * one of these is undone on both sides is counted under its name instead of
 * as unexplained. (Differences in what the CSS means are never listed here.)
 * @type {Record<string, (css: string) => string>}
 */
const benign = {
	// cssnano keeps the line break before and after a `/*! */` comment.
	'white space around important comments': (css) =>
		css.replaceAll(/\s*(\/\*![\s\S]*?\*\/)\s*/gu, '$1'),
	// cssnano keeps `;;`, `};` and a `;` before `}` or at the end around
	// custom properties and nested rules.
	'stray semicolons': (css) =>
		css
			.replaceAll(/;+(?=[;}])/gu, '')
			.replace(/;$/u, '')
			.replaceAll('};', '}'),
	// cssnano keeps the space in `--x: 1 !important` and `! important`.
	'important flag spacing': (css) => css.replaceAll(/\s*!\s*important/giu, '!important'),
	// cssnano keeps a line break in a selector (`a\n\tb`).
	'line breaks in selectors': (css) => css.replaceAll(/\s*[\n\t]\s*/gu, ' '),
	// cssnano keeps the space after the colon in a container query.
	'container query spacing': (css) =>
		css
			.replaceAll(/(@container[^{]*?)\(([\w-]+):\s*/gu, '$1($2:')
			.replaceAll(/\s{2,}/gu, ' '),
	// cssnano keeps the space after a comma inside calc().
	'comma in calc': (css) => css.replaceAll(/(calc\([^)]*?),\s+/gu, '$1,'),
	// cssnano keeps the space before a `/` once a function has been seen
	// (`url(a.png) center /cover`).
	'space before slash': (css) => css.replaceAll(/ \/(?!\*)/gu, '/'),
	// cssnano shortens a four-value box shorthand only; kd_css also
	// shortens two and three values (`1px 2px 1px` is `1px 2px`).
	'two and three value box shorthands': (css) =>
		css.replaceAll(
			/(?<=[;{])(margin|padding|border-width|border-style|border-color):([^;}!]+)/giu,
			(_, prop, value) => {
				const parts = [];
				let depth = 0;
				let current = '';
				for (const c of value) {
					if (c === '(') depth++;
					if (c === ')') depth--;
					if (c === ' ' && depth === 0) {
						parts.push(current);
						current = '';
					} else {
						current += c;
					}
				}
				parts.push(current);
				const [t, r = t, b = t, l = r] = parts;
				if (parts.length > 4) {
					return `${prop}:${value}`;
				}
				const out = [t, r, b, l];
				if (l === r) {
					out.pop();
					if (b === t) {
						out.pop();
						if (r === t) {
							out.pop();
						}
					}
				}
				return `${prop}:${out.join(' ')}`;
			},
		),
	// kd_css drops the initial `none` style from a border (`1px none #c1ebd5`);
	// cssnano does only when it knows the colour.
	'border style none': (css) =>
		css.replaceAll(
			/(?<=[;{])(border(?:-top|-right|-bottom|-left)?):([^;}!]+)/giu,
			(match, prop, value) => {
				const parts = value.split(/ (?![^(]*\))/u);
				return parts.length > 1
					? `${prop}:${parts.filter((p) => p.toLowerCase() !== 'none').join(' ')}`
					: match;
			},
		),
	// kd_css joins `a{x:1}a{x:2}` into `a{x:1;x:2}` once the two selectors
	// read the same; cssnano compares them as written.
	'adjacent rules with the same selector': (css) => {
		let out = css;
		let previous;
		do {
			previous = out;
			out = out.replaceAll(
				/(?<=^|[}{;])([^{}@;]+)\{([^{}]*)\}\1\{([^{}]*)\}/gu,
				'$1{$2;$3}',
			);
		} while (out !== previous);
		return out;
	},
	// kd_css joins `@media x{a}@media x{b}` into `@media x{ab}`; cssnano
	// does that only for some of them.
	'adjacent at-rules with the same query': joinAdjacentAtRules,
	// kd_css writes `border: none` as `border: 0` and `background: none` as
	// `background: 0 0` (what clean-css does); cssnano keeps the keywords.
	'nothing written shorter': (css) =>
		css
			.replaceAll(
				/(?<=[;{])(border(?:-top|-right|-bottom|-left)?|outline):none(?=[;}!]|$)/giu,
				'$1:0',
			)
			.replaceAll(
				/(?<=[;{])background:(?:none|transparent)(?=[;}!]|$)/giu,
				'background:0 0',
			),
	// kd_css unquotes `"KaTeX_SansSerif"`; cssnano keeps the quotes of a name
	// with `serif` anywhere inside it.
	'font family names with a keyword inside': (css) =>
		css.replaceAll(/(?<=font-family:)[^;}!]+/giu, (value) =>
			value.replaceAll(/"([A-Za-z_][\w-]*)"/gu, '$1'),
		),
	// cssnano removes duplicate selectors before it rewrites them, so
	// `p::before,p:before` survives; kd_css rewrites first.
	'duplicate selectors': (css) =>
		css.replaceAll(/(?<=^|[,{}])([^,{}]+),\1(?=[,{])/gu, '$1'),
	// cssnano keeps white space before a stray `;` between rules.
	'white space before a stray semicolon': (css) => css.replaceAll(/\s+;/gu, ';'),
};

/**
 * Names the benign category of a mismatch, or null.
 * @param {string} a - cssnano(original)
 * @param {string} b - cssnano(mine)
 * @returns {string | null} The category
 */
function categoryOf(a, b) {
	for (const [name, fix] of Object.entries(benign)) {
		if (fix(a) === fix(b)) {
			return name;
		}
	}
	let x = a;
	let y = b;
	for (const fix of Object.values(benign)) {
		x = fix(x);
		y = fix(y);
	}
	return x === y ? 'several of the above' : null;
}

const inputs = names.map((n) => path.join(dir, `${n}.in`));
const mine = runRust(inputs);
const tmp = mkdtempSync(path.join(tmpdir(), 'kd-css-'));
const again = [];
for (const n of names) {
	const out = mine.get(path.join(dir, `${n}.in`)) ?? '';
	const file = path.join(tmp, `${n}.in`);
	writeFileSync(file, out);
	again.push(file);
}
const second = runRust(again);

const failures = { rust: [], parse: [], equivalence: [], size: [], idempotence: [] };
/** @type {Map<string, number>} */
const categories = new Map();
let strictEqual = 0;
const ratios = [];
let totalMine = 0;
let totalTheirs = 0;
let totalOriginal = 0;
let gzipMine = 0;
let gzipTheirs = 0;
for (const n of names) {
	const input = readFileSync(path.join(dir, `${n}.in`), 'utf8');
	const theirs = readFileSync(path.join(dir, `${n}.out`), 'utf8');
	const out = mine.get(path.join(dir, `${n}.in`)) ?? '';
	if (out.startsWith('__ERROR__')) {
		failures.rust.push(`${n}: ${out}`);
		continue;
	}
	const again2 = second.get(path.join(tmp, `${n}.in`));
	if (again2 !== out) {
		failures.idempotence.push(`${n}: ${diffOf(out, again2 ?? '')}`);
	}
	if (mode === '') {
		// Input that postcss itself rejects (error recovery cases) may keep
		// what postcss cannot read; only the other cases must re-parse.
		const error = theirs === '__ERROR__' ? null : postcssError(out);
		if (error) {
			failures.parse.push(`${n}: ${error.split('\n')[0]}`);
			continue;
		}
		if (theirs !== '__ERROR__') {
			let mineMin;
			try {
				mineMin = await cssnanoMinify(out);
			} catch (error) {
				failures.parse.push(
					`${n}: cssnano rejects the output: ${String(error).split('\n')[0]}`,
				);
				continue;
			}
			if (mineMin === theirs) {
				strictEqual++;
			} else {
				const category = categoryOf(theirs, mineMin);
				if (category === null) {
					// Show what is left once the known leftovers are undone.
					const left = (/** @type {string} */ css) => {
						let acc = css;
						for (const fix of Object.values(benign)) {
							acc = fix(acc);
						}
						return acc;
					};
					failures.equivalence.push(`${n}: ${diffOf(left(theirs), left(mineMin))}`);
				} else {
					categories.set(category, (categories.get(category) ?? 0) + 1);
				}
			}
		}
		if (theirs === '__ERROR__') {
			continue;
		}
		const bytes = Buffer.byteLength(out);
		const theirBytes = Buffer.byteLength(theirs);
		totalMine += bytes;
		totalTheirs += theirBytes;
		totalOriginal += Buffer.byteLength(input);
		gzipMine += gzipSync(out, { level: 9 }).length;
		gzipTheirs += gzipSync(theirs, { level: 9 }).length;
		const ratio = theirBytes === 0 ? 1 : bytes / theirBytes;
		ratios.push({ n, ratio, bytes, theirBytes, original: Buffer.byteLength(input) });
		if (bytes > theirBytes * limit + 8) {
			failures.size.push(`${n}: ${bytes} vs cssnano ${theirBytes} (${ratio.toFixed(3)})`);
		}
	}
}
rmSync(tmp, { recursive: true, force: true });

if (ratios.length > 0) {
	const sorted = ratios.toSorted((a, b) => a.ratio - b.ratio);
	const median = sorted[Math.floor(sorted.length / 2)].ratio;
	const worst = sorted.at(-1);
	process.stdout.write(
		`files ${names.length}; bytes: original ${totalOriginal}, cssnano ${totalTheirs}, mine ${totalMine} ` +
			`(${((totalMine / totalTheirs) * 100).toFixed(2)} % of cssnano, ${((totalMine / totalOriginal) * 100).toFixed(2)} % of the original)\n`,
	);
	process.stdout.write(
		`size ratio mine/cssnano: median ${median.toFixed(4)}, worst ${worst.ratio.toFixed(4)} (case ${worst.n})\n`,
	);
	process.stdout.write(
		`gzip (level 9) of all files: cssnano ${gzipTheirs}, mine ${gzipMine} (${((gzipMine / gzipTheirs) * 100).toFixed(2)} % of cssnano)\n`,
	);
	// The largest files decide the bytes; show the ones with the worst ratio
	// among those over 2000 bytes.
	const big = sorted.filter((r) => r.theirBytes >= 2000);
	for (const r of big.slice(-5).toReversed()) {
		process.stdout.write(
			`  large case ${r.n}: ${r.bytes} vs cssnano ${r.theirBytes} (${r.ratio.toFixed(4)})\n`,
		);
	}
}
if (mode === '') {
	const benignTotal = [...categories.values()].reduce((a, b) => a + b, 0);
	process.stdout.write(
		`cssnano(mine) === cssnano(original): ${strictEqual} identical, ${benignTotal} differ only by a known cssnano leftover, ${failures.equivalence.length} unexplained\n`,
	);
	for (const [name, count] of categories) {
		process.stdout.write(`  ${count} x ${name}\n`);
	}
}
let bad = 0;
for (const [kind, list] of Object.entries(failures)) {
	process.stdout.write(`${kind}: ${list.length} failures\n`);
	for (const f of list.slice(0, show)) {
		process.stdout.write(`  ${f}\n`);
	}
	if (kind !== 'equivalence') {
		bad += list.length;
	}
}
process.exit(bad > 0 || failures.equivalence.length > 0 ? 1 : 0);
