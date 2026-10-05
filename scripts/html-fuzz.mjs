/**
 * Random HTML-ish inputs for the differential tests of `kd_html`: markup that
 * is broken in all the ways real pages are (unclosed and misnested tags,
 * stray closers, odd attributes, entities, comments, text with `<` and `&`).
 * The inputs avoid the constructs on which v3 differs from v2 on purpose
 * (`<?...?>`, a doctype in the middle), so a difference is a real divergence.
 */

/**
 * @param {number} seed - The seed
 * @returns {() => string} A function returning a new random input each call
 */
export function createInputGenerator(seed) {
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
	const random = rng(seed);
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
		'title',
		'xmp',
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

	return () => {
		// A doctype only ever leads: v2 loses the content around a doctype in the
		// middle of a fragment, which v3 deliberately does not reproduce.
		const pieces = 1 + Math.floor(random() * 24);
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
		return input;
	};
}
