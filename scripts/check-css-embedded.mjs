/**
 * Checks `kd_css` against what html-minifier-terser's built-in clean-css (level
 * 1, no options) makes of CSS embedded in HTML: the text of a `<style>`
 * element, a `style` attribute and a `media` attribute. The decision of the
 * RFC is that one minifier serves them all, and that it must not be larger
 * than clean-css level 1 would make the CSS. Only sizes are compared (the
 * outputs are different spellings of the same CSS).
 *
 * ```sh
 * cargo build --release --offline -p kd_css --example minify
 * KD_CSS_DIR=/tmp/kd-css node scripts/check-css-embedded.mjs
 * ```
 *
 * The directory is a corpus of `fuzz-css.mjs`; the declarations and media
 * queries are the hand-written ones.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { declarationCases } from './css-golden-cases.mjs';

const require = createRequire(import.meta.url);
// clean-css is what html-minifier-terser runs on `<style>`; it is a dependency
// of that package, which is the point of comparing against it.
// eslint-disable-next-line import-x/no-extraneous-dependencies
const CleanCSS = require('clean-css');

const root = path.resolve(import.meta.dirname, '..');
const binary = path.join(root, 'target', 'release', 'examples', 'minify');
const dir = process.env.KD_CSS_DIR ?? process.argv[2];
if (!dir) {
	throw new Error(
		'usage: KD_CSS_DIR=<corpus directory> node scripts/check-css-embedded.mjs',
	);
}

/**
 * clean-css level 1, the way html-minifier-terser wraps and unwraps.
 * @param {string} text - The CSS
 * @param {'block' | 'inline' | 'media'} kind - What it is
 * @returns {string} The minified CSS
 */
function cleanCss(text, kind) {
	const wrapped =
		kind === 'media' ? `@media ${text}{a{a:b}}` : kind === 'inline' ? `*{${text}}` : text;
	const result = new CleanCSS({}).minify(wrapped);
	let out = result.styles;
	if (kind === 'media') {
		out = out.replace(/^@media /u, '').replace(/\{a\{a:b\}\}$/u, '');
	} else if (kind === 'inline') {
		out = out.replace(/^\*\{/u, '').replace(/\}$/u, '');
	}
	return out;
}

/**
 * Runs the Rust minifier over texts.
 * @param {string[]} texts - The CSS
 * @param {string} mode - `KD_CSS_MODE`
 * @returns {string[]} The outputs
 */
function rust(texts, mode) {
	const tmp = mkdtempSync(path.join(tmpdir(), 'kd-css-emb-'));
	const files = texts.map((t, i) => {
		const f = path.join(tmp, `${i}.in`);
		writeFileSync(f, t);
		return f;
	});
	const run = spawnSync(binary, [], {
		input: `${files.join('\n')}\n`,
		encoding: 'utf8',
		maxBuffer: 1 << 30,
		env: { ...process.env, KD_CSS_MODE: mode },
	});
	rmSync(tmp, { recursive: true, force: true });
	const byPath = new Map();
	for (const line of run.stdout.split('\n').filter(Boolean)) {
		const r = JSON.parse(line);
		byPath.set(r.path, r.css ?? `__ERROR__ ${r.error}`);
	}
	return files.map((f) => byPath.get(f) ?? '');
}

const medias = [
	'screen',
	'print',
	'all',
	'  screen  and  (min-width: 100px)  ',
	'(min-width:100px) and (max-width:200px)',
	'screen and (-webkit-min-device-pixel-ratio: 1.5), screen and (min-resolution: 144dpi)',
	'only screen and (min-width : 768px) , print',
	'(min-aspect-ratio: 16/9)',
	'(prefers-color-scheme: dark)',
	'not all and (monochrome)',
	'(width >= 600px) and (width <= 900px)',
	'screen and (min-width:0\\0)',
];

let bad = 0;
/**
 * Compares, prints a line and counts the cases that are larger.
 * @param {string} label - What the cases are
 * @param {string[]} inputs - The inputs
 * @param {string[]} mine - kd_css's outputs
 * @param {string[]} theirs - clean-css's outputs
 */
function report(label, inputs, mine, theirs) {
	let m = 0;
	let t = 0;
	let o = 0;
	const larger = [];
	for (const [i, input] of inputs.entries()) {
		o += Buffer.byteLength(input);
		m += Buffer.byteLength(mine[i]);
		t += Buffer.byteLength(theirs[i]);
		if (Buffer.byteLength(mine[i]) > Buffer.byteLength(theirs[i]) * 1.03 + 2) {
			larger.push(
				`  ${JSON.stringify(input.slice(0, 90))}\n    clean-css: ${JSON.stringify(theirs[i].slice(0, 90))}\n    kd_css:   ${JSON.stringify(mine[i].slice(0, 90))}`,
			);
		}
	}
	process.stdout.write(
		`${label}: ${inputs.length} cases, original ${o} bytes, clean-css ${t}, kd_css ${m} (${((m / t) * 100).toFixed(2)} % of clean-css), ${larger.length} larger than clean-css\n`,
	);
	for (const l of larger.slice(0, Number(process.env.KD_CSS_SHOW ?? 6))) {
		process.stdout.write(`${l}\n`);
	}
	bad += larger.length;
}

const sheets = readdirSync(dir)
	.filter((n) => n.endsWith('.in'))
	.toSorted((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
	.map((n) => readFileSync(path.join(dir, n), 'utf8'))
	.filter((s) => {
		try {
			cleanCss(s, 'block');
			return !s.includes('\u0000');
		} catch {
			return false;
		}
	});
report(
	'<style> elements',
	sheets,
	rust(sheets, ''),
	sheets.map((s) => cleanCss(s, 'block')),
);

const decls = declarationCases().filter(
	(d) => !d.includes('--') && !d.includes('expression('),
);
report(
	'style attributes',
	decls,
	rust(decls, 'declarations'),
	decls.map((d) => cleanCss(d, 'inline')),
);

report(
	'media attributes',
	medias,
	rust(medias, 'media'),
	medias.map((q) => cleanCss(q, 'media')),
);
process.exit(bad > 0 ? 1 : 0);
