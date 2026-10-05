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
 * (`<?...?>`, `<title>`, `<xmp>`), so any difference is a real divergence.
 * The corpus is not committed: it is large and fully determined by the seed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { domSerialize } from '../packages/kamado/src/utils/dom.ts';

const [outDirArg, countArg = '5000', seedArg = '1'] = process.argv.slice(2);
if (!outDirArg) {
	process.stderr.write('usage: fuzz-html-differential.mjs <outDir> [count] [seed]\n');
	process.exit(2);
}
const outDir = path.resolve(outDirArg);
const count = Number(countArg);

/**
 * A small deterministic PRNG (mulberry32).
 * @param {number} seed - The seed
 * @returns {() => number} A function returning numbers in [0, 1)
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
 * @param {readonly string[]} list - The choices
 * @returns {string} One of them
 */
const pick = (list) => list[Math.floor(random() * list.length)];

const tags = [
	'div',
	'p',
	'span',
	'a',
	'ul',
	'ol',
	'li',
	'table',
	'thead',
	'tbody',
	'tr',
	'td',
	'th',
	'select',
	'option',
	'optgroup',
	'br',
	'img',
	'input',
	'hr',
	'b',
	'i',
	'em',
	'strong',
	'h1',
	'h2',
	'form',
	'button',
	'pre',
	'dl',
	'dt',
	'dd',
	'section',
	'main',
	'nav',
	'svg',
	'path',
	'g',
	'circle',
	'textarea',
	'script',
	'style',
	'noscript',
	'iframe',
	'label',
	'fieldset',
	'legend',
	'caption',
	'colgroup',
	'col',
	'html',
	'head',
	'body',
	'meta',
	'link',
	'base',
	'DIV',
	'P',
	'Span',
	'SVG',
	'foreignObject',
	'math',
	'template',
	'details',
	'summary',
];
const attrNames = [
	'class',
	'id',
	'href',
	'src',
	'style',
	'title',
	'data-x',
	'disabled',
	'checked',
	'hidden',
	'selected',
	'value',
	'lang',
	'CLASS',
	'Id',
	'viewBox',
	'xlink:href',
	'a',
	'b',
	'x-y',
];
const attrValues = [
	'',
	'a',
	'a b',
	'  a   b  ',
	'x"y',
	"x'y",
	'a&amp;b',
	'a&b',
	'&copy;',
	'&lt;p&gt;',
	'1',
	'日本語',
	'/path/to?x=1&y=2',
	'a<b',
	'a\nb',
	'a\tb',
	'&#65;',
	'&unknown;',
	'&amp',
];
const texts = [
	'text',
	' ',
	'  \n  ',
	'a & b',
	'a &amp; b',
	'&copy; 2026',
	'&nbsp;',
	'&#160;',
	'&#x41;',
	'&lt;tag&gt;',
	'日本語のテキスト',
	'< b',
	'a < b',
	'a > b',
	'&',
	'&&',
	'&#',
	'&#x',
	'&unknown',
	'&ampx',
	'&notit;',
	'"quoted"',
	"it's",
	' ',
	'\n',
	'\t',
	'--',
	'-->',
	']]>',
];
const specials = [
	'<!-- c -->',
	'<!---->',
	'<!-->',
	'<!--->',
	'<!-- a -- b -->',
	'<!-- unclosed',
	'<![CDATA[x]]>',
	'<![CDATA[',
	'<!ELEMENT a>',
	'<!',
	'</',
	'<',
	'</>',
	'<>',
	'< p>',
	'</ p>',
	'<p/>',
	'<br/>',
	'<div/>',
	'<a href=x/>',
	'<a href=/x/>',
	'<a / b>',
	'<a b=>',
	'<a =b>',
	'<a b=\'c\' d="e" f=g h>',
	'<a b = "c">',
	'<a b="c"d="e">',
	'<a\nb\n=\n"c">',
];

/**
 * @returns {string} One random open tag with random attributes
 */
function openTag() {
	const name = pick(tags);
	let s = `<${name}`;
	const n = Math.floor(random() * 4);
	for (let i = 0; i < n; i++) {
		const attr = pick(attrNames);
		const kind = random();
		if (kind < 0.2) {
			s += ` ${attr}`;
		} else if (kind < 0.6) {
			s += ` ${attr}="${pick(attrValues).replaceAll('"', '&quot;')}"`;
		} else if (kind < 0.8) {
			s += ` ${attr}='${pick(attrValues).replaceAll("'", '&#39;')}'`;
		} else {
			s += ` ${attr}=${pick(['a', '1', 'x-y', '/p', '&amp;'])}`;
		}
	}
	return `${s}${random() < 0.1 ? '/' : ''}>`;
}

/**
 * @returns {string} One random piece of markup
 */
function piece() {
	const r = random();
	if (r < 0.35) {
		return openTag();
	}
	if (r < 0.55) {
		return `</${pick(tags)}>`;
	}
	if (r < 0.85) {
		return pick(texts);
	}
	return pick(specials);
}

mkdirSync(outDir, { recursive: true });
let written = 0;
for (let n = 0; n < count; n++) {
	const pieces = 1 + Math.floor(random() * 24);
	// A doctype only ever leads: v2 loses the content around a doctype in the
	// middle of a fragment, which v3 deliberately does not reproduce.
	let input = pick([
		'',
		'',
		'',
		'<!doctype html>',
		'<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0//EN" "http://example.com/x.dtd">',
	]);
	for (let i = 0; i < pieces; i++) {
		input += piece();
	}
	const expected = await domSerialize(input, { hook: () => {} }).catch(
		() => '__LINKEDOM_THREW__',
	);
	writeFileSync(path.join(outDir, `${n}.in`), input);
	writeFileSync(path.join(outDir, `${n}.out`), expected);
	written++;
}
process.stdout.write(`wrote ${written} cases to ${outDir}\n`);
