/**
 * Differential test input for `kd_html::print`: random but well-formed HTML
 * documents (what the serializer would produce), each with what prettier makes
 * of it. Written as `<n>.in` / `<n>.out` for the ignored Rust test
 * `crates/kd_html/tests/print_differential.rs`:
 *
 * ```sh
 * node scripts/fuzz-html-print.mjs /tmp/kd-print 3000 1
 * KD_PRINT_DIR=/tmp/kd-print cargo test --release -p kd_html --test print_differential -- --ignored
 * ```
 *
 * Inputs that prettier rejects are stored with the marker `__ERROR__` as the
 * expectation: the Rust printer must reject them too.
 *
 * The generator stays away from `<script>`, `<style>`, `style` attributes and
 * event handlers: prettier formats their code and v2 minified it afterwards,
 * so they are checked with the minifier, not here.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { prettierHtml } from './v2-print.mjs';

const [outDirArg, countArg = '1000', seedArg = '1', optionsArg = '{}'] =
	process.argv.slice(2);
if (!outDirArg) {
	process.stderr.write(
		'usage: fuzz-html-print.mjs <outDir> [count] [seed] [optionsJson]\n',
	);
	process.exit(2);
}
const outDir = path.resolve(outDirArg);
const count = Number(countArg);
const options = JSON.parse(optionsArg);

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
/**
 * @param {number} n - Upper bound (exclusive)
 * @returns {number} An integer below it
 */
const below = (n) => Math.floor(random() * n);

const blockTags = [
	'div',
	'section',
	'article',
	'main',
	'nav',
	'aside',
	'header',
	'footer',
	'form',
	'ul',
	'ol',
	'dl',
	'blockquote',
	'p',
	'h1',
	'h2',
	'table',
	'fieldset',
	'details',
];
const inlineTags = [
	'span',
	'a',
	'b',
	'i',
	'em',
	'strong',
	'code',
	'small',
	'label',
	'abbr',
	'sub',
	'sup',
	'button',
	'select',
];
const voidTags = ['br', 'img', 'input', 'hr', 'meta', 'link', 'wbr'];
const words = [
	'lorem',
	'ipsum',
	'dolor',
	'sit',
	'amet',
	'consectetur',
	'日本語',
	'テキスト',
	'a',
	'b',
	'1',
	'2026',
	'&amp;',
	'&lt;x&gt;',
	'&copy;',
	'foo-bar',
	'—',
];
const attrNames = [
	'class',
	'id',
	'href',
	'src',
	'alt',
	'title',
	'data-x',
	'lang',
	'rel',
	'type',
	'name',
	'value',
	'role',
	'aria-label',
	'hidden',
	'disabled',
	'srcset',
	'allow',
];
const attrValues = [
	'a',
	'a b',
	'  a   b  ',
	'',
	'x"y',
	"x'y",
	'/path/x.html',
	'https://example.com/?a=1&amp;b=2',
	'日本語',
	'a\nb',
	'1x',
	'a.jpg 1x, b.jpg 2x',
	'a.jpg 100w, b.jpg 200w',
];

/**
 * @returns {string} Some white space (sometimes with line breaks)
 */
function space() {
	return pick([' ', ' ', ' ', '', '', '\n', '\n  ', '\n\n', '\t', '  ']);
}

/**
 * @returns {string} Text of a few words
 */
function text() {
	const n = 1 + below(6);
	return Array.from({ length: n }, () => pick(words)).join(pick([' ', ' ', '\n', '  ']));
}

/**
 * @returns {string} Attributes (with a leading space each)
 */
function attrs() {
	const n = below(4);
	let out = '';
	for (let i = 0; i < n; i++) {
		const name = pick(attrNames);
		if (name === 'hidden' || name === 'disabled') {
			out += ` ${name}`;
			continue;
		}
		const value = pick(attrValues);
		const quote = value.includes('"') ? "'" : '"';
		const escaped = quote === '"' ? value.replaceAll('"', '&quot;') : value;
		out += ` ${name}=${quote}${escaped}${quote}`;
	}
	return out;
}

/**
 * @param {number} depth - The nesting depth so far
 * @returns {string} A node
 */
function node(depth) {
	const r = random();
	if (depth > 4 || r < 0.3) {
		return text();
	}
	if (r < 0.4) {
		return `<${pick(voidTags)}${attrs()}>`;
	}
	if (r < 0.45) {
		return `<!-- ${pick(words)} -->`;
	}
	const tag = r < 0.7 ? pick(inlineTags) : pick(blockTags);
	let inner = '';
	const n = below(4);
	switch (tag) {
		case 'ul':
		case 'ol': {
			for (let i = 0; i < n + 1; i++) {
				inner += `${space()}<li${attrs()}>${node(depth + 1)}</li>`;
			}

			break;
		}
		case 'dl': {
			for (let i = 0; i < n + 1; i++) {
				inner += `${space()}<dt>${text()}</dt>${space()}<dd>${node(depth + 1)}</dd>`;
			}

			break;
		}
		case 'table': {
			for (let i = 0; i < n + 1; i++) {
				inner += `${space()}<tr><td>${node(depth + 1)}</td><td>${text()}</td></tr>`;
			}

			break;
		}
		case 'select': {
			for (let i = 0; i < n + 1; i++) {
				inner += `<option value="${i}">${pick(words)}</option>`;
			}

			break;
		}
		default: {
			for (let i = 0; i < n; i++) {
				inner += `${space()}${node(depth + 1)}`;
			}
			inner += space();
		}
	}
	return `<${tag}${attrs()}>${inner}</${tag}>`;
}

/**
 * @returns {string} A whole input: a fragment or a document
 */
function page() {
	const r = random();
	if (r < 0.5) {
		let out = '';
		const n = 1 + below(5);
		for (let i = 0; i < n; i++) {
			out += `${node(0)}${space()}`;
		}
		return out;
	}
	const head = `<head>${space()}<meta charset="utf-8">${space()}<title>${text()}</title>${space()}<link rel="stylesheet" href="/a.css">${space()}</head>`;
	let body = '';
	const n = 1 + below(4);
	for (let i = 0; i < n; i++) {
		body += `${space()}${node(0)}`;
	}
	return `<!DOCTYPE html>${pick(['\n', ''])}<html lang="ja">${space()}${head}${space()}<body${attrs()}>${body}${space()}</body>${space()}</html>${pick(['\n', ''])}`;
}

mkdirSync(outDir, { recursive: true });
let written = 0;
for (let n = 0; n < count; n++) {
	const input = page();
	let expected;
	try {
		expected = await prettierHtml(input, options);
	} catch {
		expected = '__ERROR__';
	}
	writeFileSync(path.join(outDir, `${n}.in`), input);
	writeFileSync(path.join(outDir, `${n}.out`), expected);
	written++;
}
writeFileSync(path.join(outDir, 'options.json'), JSON.stringify(options));
process.stdout.write(`wrote ${written} cases to ${outDir}\n`);
