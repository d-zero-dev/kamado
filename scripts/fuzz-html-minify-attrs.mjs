/**
 * Differential test input for the attribute rewrites of `kd_html::minify`:
 * random start tags built from the attributes html-minifier-terser treats
 * specially (booleans, redundant ones, `class`, `style`, `srcset`, `media`,
 * viewport, CSP, `type` of scripts and styles, URLs, numbers, event
 * handlers), written in odd spellings. Same files and test as
 * `fuzz-html-minify.mjs`:
 *
 * ```sh
 * node scripts/fuzz-html-minify-attrs.mjs /tmp/kd-minify-attrs 5000 1
 * KD_MINIFY_DIR=/tmp/kd-minify-attrs cargo test --release -p kd_html --test minify_differential -- --ignored
 * ```
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { v2Minify } from './v2-print.mjs';

const [outDirArg, countArg = '1000', seedArg = '1'] = process.argv.slice(2);
if (!outDirArg) {
	process.stderr.write('usage: fuzz-html-minify-attrs.mjs <outDir> [count] [seed]\n');
	process.exit(2);
}
const outDir = path.resolve(outDirArg);

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

const tags = [
	'a',
	'area',
	'img',
	'input',
	'script',
	'style',
	'link',
	'meta',
	'form',
	'div',
	'span',
	'button',
	'select',
	'textarea',
	'td',
	'col',
	'source',
	'iframe',
	'video',
	'details',
	'svg',
	'object',
	'blockquote',
	'q',
];
const names = [
	'disabled',
	'DISABLED',
	'checked',
	'hidden',
	'draggable',
	'open',
	'async',
	'defer',
	'class',
	'CLASS',
	'style',
	'srcset',
	'media',
	'content',
	'name',
	'http-equiv',
	'type',
	'language',
	'charset',
	'method',
	'shape',
	'href',
	'src',
	'cite',
	'action',
	'tabindex',
	'maxlength',
	'rowspan',
	'span',
	'onclick',
	'onload',
	'rel',
	'id',
	'data-x',
	'value',
	'title',
];
const values = [
	'',
	'disabled',
	'true',
	'false',
	'  a   b  ',
	'a\tb\nc',
	'a b',
	'text/javascript',
	'text/css',
	' TEXT/CSS ',
	'module',
	'application/json',
	'text/javascript; charset=utf-8',
	'text/javascript ; x',
	'javascript',
	'JavaScript',
	'get',
	'GET',
	'post',
	'text',
	'rect',
	'viewport',
	'width=device-width, initial-scale=1.0',
	'width = device-width , initial-scale = 1.50',
	'content-security-policy',
	"default-src  'self';   img-src *",
	'stylesheet',
	'canonical',
	'a.jpg 1x, b.jpg 2x',
	'a.jpg 1.0x,b.jpg 2.50x',
	'a.jpg 100w , b.jpg 200w',
	'a.jpg,b.jpg',
	'a.jpg 1x',
	'a.jpg   2x',
	'color: red;',
	'color: red ; ',
	'color:red;;',
	'width: 1px;  height: 2px',
	'content: "a&amp;";',
	'screen and (min-width: 100px)',
	'  screen  ',
	'  /path/x.html ',
	'javascript:void(0)',
	' javascript: alert(1) ',
	'alert(1);',
	'  3 ',
	'x"y',
	"x'y",
	'x"y\'z',
	'&amp;',
	'日本語',
	'a=b',
];

/**
 * @returns {string} One attribute in some spelling
 */
function attribute() {
	const name = pick(names);
	const r = random();
	if (r < 0.2) {
		return name;
	}
	const value = pick(values);
	const spacing = pick(['=', '=', ' = ', '= ', ' =']);
	if (r < 0.3 && !/[\s"'`=<>]/.test(value) && value !== '') {
		return `${name}=${value}`;
	}
	if (value.includes('"')) {
		return `${name}${spacing}'${value.replaceAll("'", '&#39;')}'`;
	}
	return `${name}${spacing}"${value}"`;
}

/**
 * @returns {string} One start tag with its attributes and content
 */
function element() {
	const tag = pick(tags);
	const n = Math.floor(random() * 5);
	let attrs = '';
	for (let i = 0; i < n; i++) {
		attrs += ` ${attribute()}`;
	}
	const close = pick(['>', '>', '>', ' />', '/>']);
	if (['img', 'input', 'link', 'meta', 'area', 'col', 'source'].includes(tag)) {
		return `<${tag}${attrs}${close}`;
	}
	if (tag === 'script') {
		return `<script${attrs}>${pick(['', 'var a = 1;', 'if (a < b) { x() }'])}</script>`;
	}
	if (tag === 'style') {
		return `<style${attrs}>${pick(['', 'a { color: red }', 'a>b{c:d}'])}</style>`;
	}
	return `<${tag}${attrs}>${pick(['', 'text', 'a  b'])}</${tag}>`;
}

mkdirSync(outDir, { recursive: true });
let written = 0;
let errors = 0;
for (let n = 0; n < Number(countArg); n++) {
	const count = 1 + Math.floor(random() * 4);
	let input = '';
	for (let i = 0; i < count; i++) {
		input += `${element()}\n`;
	}
	let expected;
	try {
		expected = await v2Minify(input);
	} catch {
		expected = '__ERROR__';
		errors++;
	}
	writeFileSync(path.join(outDir, `${written}.in`), input);
	writeFileSync(path.join(outDir, `${written}.out`), expected);
	written++;
}
process.stdout.write(`wrote ${written} cases (${errors} rejected) to ${outDir}\n`);
