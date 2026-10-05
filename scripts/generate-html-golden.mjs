/**
 * Generates the differential corpus of `kd_html`: each case is an input that
 * v2 parsed and serialized with linkedom (`domSerialize` with a no-op hook),
 * stored next to the output v2 produced. The Rust test
 * `crates/kd_html/tests/golden.rs` runs the same inputs through
 * `kd_html::page::Page` and requires the same bytes.
 *
 * linkedom is a dev-time input only. Run this when a case is added:
 * `node scripts/generate-html-golden.mjs`.
 *
 * Inputs on which v3 deliberately differs are NOT cases here; they live as
 * unit tests in the Rust crate (`<?php ?>`, `<title>` and `<xmp>` raw text,
 * an attribute value containing `><` in a raw-text element's start tag).
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { domSerialize } from '../packages/kamado/src/utils/dom.ts';

import { cases as extraCases } from './html-golden-cases.mjs';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'crates', 'kd_html', 'tests', 'golden');

/** @type {Record<string, string>} */
const cases = {
	'fragment-text': 'plain & <b>text</b> with &copy; and &nbsp; and "quotes"',
	'fragment-nesting': '<div><p>a<span>b</span></p><ul><li>1<li>2</ul></div>',
	'fragment-comments': '<!-- a --><p>x</p><!----><!-- b -->tail',
	'comment-alt-end': '<!-- a --!><p>x</p>',
	'attributes-quoting':
		'<a href=x title=\'He said "hi"\' alt="it\'s" data-x data-y="" CLASS="  a   b ">t</a>',
	'attributes-empty-special': '<div id="" class="" style="" hidden="" data-z="">x</div>',
	'attributes-duplicates': '<p a=1 a=2 b=3>x</p>',
	'attributes-ampersand': '<a href="?a=1&b=2&amp;c=3" title="a<b>c">x</a>',
	'void-elements':
		'<br><br/><img src=a.png alt=x><hr><input disabled value=v><wbr><embed src=e>',
	'void-odd': '<basefont><frame><command><isindex><keygen><menuitem>m</menuitem>',
	'svg-inline':
		'<svg viewBox="0 0 10 10"><path d="M0 0"/><circle r=1></circle><g><use href="#a"/></g></svg>',
	'svg-case': '<SVG viewBox=1><Path/><linearGradient id=g></linearGradient></SVG>',
	'script-style':
		'<script>if(a<b&&c>d){x="</div>"}</script><style>a>b{content:"&amp;"}</style><p>after</p>',
	'script-attrs': '<script async defer type="module" src="a.js"></script>',
	textarea: '<textarea rows=2>&lt;b&gt; &amp; <i>x</i></textarea>',
	'entities-named': '<p>&lt;&gt;&amp;&quot;&apos;&copy;&reg;&hellip;&mdash;&yen;</p>',
	'entities-legacy': '<p>&copy &amp &lt &notit; &ampx &copyx</p>',
	'entities-numeric': '<p>&#65;&#x42;&#128512;&#0;&#x80;&#xD800;&#1114112;</p>',
	'entities-in-attrs': '<a title="&copy;&amp;&lt;" href="?a=1&copy=2&copy;">x</a>',
	'nbsp-and-multibyte': '<p title="日本語">こんにちは 世界 é</p>',
	'tables-no-tbody': '<table><tr><td>a<td>b<tr><td>c</table>',
	'tables-nested': '<table><tr><td><table><tr><td>x</td></tr></table></td></tr></table>',
	'implied-close-p': '<p>a<div>b</div><p>c<p>d',
	'implied-close-li-dt': '<dl><dt>a<dd>b<dt>c</dl><ul><li>1<li>2</ul>',
	'implied-close-select': '<select><option>a<option>b<optgroup><option>c</select>',
	'misnested-inline': '<b><i>x</b>y</i>',
	'stray-closers': '</div></p></br>text</span>',
	'broken-tags': '<div <p>a</div><a href="x>y</a><b>c',
	'unclosed-at-eof': '<div><p>a<span>b',
	'lone-lt-gt': 'a < b > c <3 <> <1> </>',
	'cdata-in-html': '<p><![CDATA[x<y]]></p>',
	declaration: '<p>a</p><!ELEMENT x><p>b</p>',
	'doctype-fragment': '<!doctype html><p>x</p>',
	'doc-basic':
		'<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>t</title></head><body><p>x</p></body></html>',
	'doc-no-head': '<!doctype html><html><body><p>x</p></body></html>',
	'doc-uppercase':
		'<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN"><HTML><HEAD></HEAD><BODY>x</BODY></HTML>',
	'doc-leading-comment':
		'<!-- license -->\n<!doctype html><html><head></head><body>x</body></html>',
	'doc-bare-doctype': '<!doctype html>',
	'doc-doctype-no-html': '<!doctype html><p>x</p>',
	'doc-html-only': '<html></html>',
	'doc-with-scripts':
		'<!doctype html><html><head><script>var a = "<b>";</script><style>p>a{}</style></head><body><noscript><img src=a.png></noscript></body></html>',
	'pre-and-whitespace': '<pre>\n  a\n\tb  </pre>\n\n<p>  spaced   out  </p>',
	'iframe-noembed': '<iframe src=a>x &lt; y</iframe><noembed><b>n</b></noembed>',
	'json-ld': '<script type="application/ld+json">{"a":"</b>","b":"&amp;"}</script>',
	'form-controls':
		'<form><input type=checkbox checked><input type=text value=""><button disabled>b</button></form>',
	// Where the input ends inside a construct: what survives is decided by the
	// tokenizer's state at the end, including one quirk (a closing tag that
	// never sees `>` leaves its last character behind as text).
	'eof-attr-then-slash': '<p>a</p><a &amp; b</',
	'eof-self-closing': '<div><a b/',
	'eof-self-closing-bare': '<div><a/',
	'eof-unquoted-value': '<div><a b=c/',
	'eof-closing-tag-name': '<div></a',
	'eof-closing-tag-space': '<dl></a ',
	'eof-closing-tag-text': '<dl></a < b',
	'eof-closing-tag-multibyte': '<dl></a 日本',
	'eof-comment': '<p>a</p><!-- x',
	'eof-declaration': '<p>a</p><!x y',
	'eof-double-quoted': '<div><a b="c',
	'eof-single-quoted': "<div><a b='",
	'eof-open-lt': '<p>a</p><',
	'eof-before-closing': '<p>a</p></',
	'eof-entity-bare': 'a &',
	'eof-entity-numeric': 'a &#',
	'eof-entity-hex': 'a &#x4',
	'eof-entity-named': 'a &copy',
	'eof-entity-in-attr': '<a b="&copy',
	'eof-attribute-name': '<div a=b c',
	'eof-in-svg': '<svg><path d="M0',
	'eof-script': '<script>var a = 1;',
	'eof-style': '<style>a{',
	'eof-textarea': '<textarea>a &lt; b',
	'eof-cdata': '<p>a</p><![CDATA[x',
};

mkdirSync(outDir, { recursive: true });
// A removed case must not leave its files behind (the Rust test would still
// run them), so the directory is rebuilt from scratch.
for (const file of readdirSync(outDir)) {
	if (file.endsWith('.in') || file.endsWith('.out')) {
		rmSync(path.join(outDir, file));
	}
}
let count = 0;
for (const [name, input] of Object.entries({ ...extraCases, ...cases })) {
	const expected = await domSerialize(input, { hook: () => {} });
	// Not `.html`: the inputs are deliberately broken markup that the HTML
	// linters and the formatter must not touch.
	writeFileSync(path.join(outDir, `${name}.in`), input);
	writeFileSync(path.join(outDir, `${name}.out`), expected);
	count++;
}
process.stdout.write(`wrote ${count} cases to ${path.relative(root, outDir)}\n`);
