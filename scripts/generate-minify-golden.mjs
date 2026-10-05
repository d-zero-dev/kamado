/**
 * Writes the golden cases of `kd_html::minify`: hand-picked inputs and what
 * html-minifier-terser (with v2's options, code minifiers off) makes of them,
 * as `crates/kd_html/tests/minify_golden/<n>.in` / `.out` (`__ERROR__` for an
 * input the minifier rejects). The random corpora cannot reach custom
 * fragments, ignore markers, conditional comments and svg, so they are here.
 * Run it when html-minifier-terser is upgraded:
 * `node scripts/generate-minify-golden.mjs`.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { v2Minify } from './v2-print.mjs';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'crates', 'kd_html', 'tests', 'minify_golden');

const cases = [
	// custom fragments
	'<?php echo $a; ?>\n<p>x</p>\n',
	'<div><?php if ($a): ?> <b>x</b> <?php endif; ?></div>\n',
	'<a href="<?php echo $u ?>">x</a>\n',
	'<?php a ?><?php b ?> text <?php c ?>\n',
	'<p><%= a %> and <% b %></p>\n',
	'<?xml version="1.0"?>\n<p>x</p>\n',
	'<div>\n\t<?php x ?>\n</div>\n',
	'<p class="<?php echo 1 ?>  x">y</p>\n',
	'<?php\n?>\n',
	'<? short ?>\n<p>x</p>\n',
	// ignore markers
	'<p>a</p>\n<!-- htmlmin:ignore --><p   class="x"   disabled="disabled">  keep  </p><!-- htmlmin:ignore -->\n<p   class="y   z">b</p>\n',
	'<!-- htmlmin:ignore -->unterminated <p disabled="disabled">\n',
	'<!-- htmlmin:ignore --><b>1</b><!-- htmlmin:ignore --><!-- htmlmin:ignore --><i>2</i><!-- htmlmin:ignore -->\n',
	// comments, doctype, cdata
	'<!DOCTYPE   html>\n<html></html>\n',
	'<!doctype html>\n<p>x</p>\n',
	'<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN"\n  "http://www.w3.org/TR/html4/strict.dtd">\n<p>x</p>\n',
	'<!--[if IE]><p disabled="disabled">x</p><![endif]-->\n<p>y</p>\n',
	'<![if IE]><p>x</p><![endif]>\n',
	'<![CDATA[ a ]]>\n<p>x</p>\n',
	'<!-- a -- b -->\n<!---->\n<!-->\n<p>x</p>\n',
	'<p>x</p><!-- unterminated\n',
	// svg
	'<svg viewBox="0 0 1 1" xmlns="http://www.w3.org/2000/svg"><path d="M0 0" fill=none /><linearGradient id="a"></linearGradient></svg>\n',
	'<svg><foreignObject><div CLASS="  a   b  ">x</div></foreignObject></svg>\n<div CLASS="  a   b  ">x</div>\n',
	'<svg><circle cx="1" cy="1" r="1"/></svg><br/><img src="a.png"/>\n',
	'<SVG viewBox="0 0 1 1"><PATH D="M0 0"/></SVG>\n',
	'<svg><style>a{color:red}</style><script type="text/javascript">a()</script></svg>\n',
	// tags
	'<P>a<DIV>b</DIV></P>\n',
	'<p>a<div>b</div>\n',
	'<p>a</p></p><br></br></br><p>\n',
	'<ul><li>a<li>b<ul><li>c</ul></ul>\n',
	'<table><col><col><tr><td>a<td>b<tr><td>c</table>\n',
	'<table><colgroup><col></colgroup><thead><tr><th>a<tbody><tr><td>b<tfoot><tr><td>c</table>\n',
	'<select><option>a<option>b</select>\n',
	'<dl><dt>a<dd>b<dt>c</dl>\n',
	'<html><head><title>x</title></head><body><p>y</body></html>\n',
	'<head><meta charset="utf-8"><html lang="ja">\n',
	'<a:b c:d="e">x</a:b>\n',
	'<日本語 属性="値">x</日本語>\n',
	'<p>a < b > c</p>\n',
	'a <b\n',
	'<1>\n',
	'< p>\n',
	'<p\n',
	'<p a="b"c="d">x</p>\n',
	"<p a=b=c d='e' f=g>x</p>\n",
	'<p a="b" a="c">x</p>\n',
	'<p a = "b"\n\tc\n=\n"d">x</p>\n',
	'<p a=">">x</p>\n',
	'<p a=`b`>x</p>\n',
	'<p "a"=b>x</p>\n',
	'<img src=a.png alt=>\n',
	'<img src=a.png alt= >\n',
	// raw text
	'<script>if (a < b && c > d) { x("</p>") }</script>\n',
	'<script>unterminated\n',
	'<style>a > b { c: d }</style>\n<style>unterminated',
	'<SCRIPT TYPE="TEXT/JAVASCRIPT">a()</SCRIPT>\n',
	'<script type="application/ld+json">{"a": 1}</script>\n',
	'<script type="module">import a from "b"</script>\n',
	'<script type="text/javascript; charset=utf-8" language="JavaScript" charset="utf-8">a()</script>\n',
	'<script src="a.js" charset="utf-8" type="text/javascript"></script>\n',
	'<script type=" TEXT/JAVASCRIPT ;x ">a()</script>\n',
	'<script type="text/x-template"><p disabled="disabled"></p></script>\n',
	'<style type="text/css" media="  screen  ">a{b:c}</style>\n',
	'<style type="text/less">a{b:c}</style>\n',
	'<link rel="stylesheet" type="text/css" href="  a.css " media=" print ">\n',
	'<link rel="canonical" href="  http://example.com/  ">\n',
	'<textarea>  a\n  b </textarea><pre>  a\n  b </pre>\n',
	// attributes
	'<input type="text" disabled="disabled" CHECKED="checked" value="x">\n',
	'<input type="TEXT"><input type=" text "><input type="Text">\n',
	'<form method="get" action="  /a  "><input type="search"></form>\n',
	'<form method="GET"></form><form method=" Get "></form>\n',
	'<a name="x" id="y">a</a><a name="x">b</a>\n',
	'<area shape="rect" shape="RECT"><area shape=" rect ">\n',
	'<div hidden="hidden" draggable="true" draggable="false" draggable="auto" draggable>x</div>\n',
	'<video controls="controls" autoplay="" muted loop="loop"></video>\n',
	'<details open="open"><summary>a</summary></details>\n',
	'<option selected="selected" value="a">x</option>\n',
	'<div class="  a   b\tc\n d  " id="  x  " title="  y  ">x</div>\n',
	'<div class=" "></div><div class=""></div>\n',
	'<div style="color: red ; "></div><div style=" a:b;;"></div><div style="a:b&#59;"></div><div style=""></div>\n',
	'<img srcset=" a.jpg 1x , b.jpg  2x " src="a.jpg">\n',
	'<img srcset="a.jpg 1.0x, b.jpg 2.50x, c.jpg 100w, d.jpg 0w, e.jpg 1.x">\n',
	'<img srcset="a.jpg, b.jpg 2x">\n<source srcset="  a.webp  ">\n<div srcset=" a  1x ">x</div>\n',
	'<meta name="viewport" content=" width = device-width , initial-scale = 1.0 , maximum-scale=0.90000">\n',
	'<meta http-equiv="Content-Security-Policy" content="default-src   \'self\';\n  img-src  *">\n',
	'<meta http-equiv="refresh" content="  5  ">\n',
	'<meta http-equiv content="x">\n',
	'<meta name="description" content="  a   b  ">\n',
	'<a href="  /a  " onclick=" javascript: alert(1) " tabindex=" 3 ">x</a>\n',
	'<a href="javascript:void(0)">x</a>\n',
	'<td rowspan=" 2 " colspan="3 "></td><col span=" 2 "><input maxlength=" 9 " tabindex=" 1 ">\n',
	'<div onclick="" onmouseover=" a() " ONCLICK=" b() " onx=" c() ">x</div>\n',
	'<p title="a&quot;b" data-a=\'a"b\' data-b="a\'b" data-c=\'a"b\'c\'>x</p>\n',
	'<p title=\'a"b"c\' alt="a\'b\'c">x</p>\n',
	'<p title="&amp; &lt; &gt; &#34; &#39;">x</p>\n',
	'<p TITLE="x" Data-X="y" xlink:href="z">x</p>\n',
	'<img src="a.png" alt="" title>\n',
	'<button disabled="DISABLED"></button><button disabled="Disabled "></button>\n',
	'<object data="  a  " classid="  b  " usemap=" #c "></object>\n',
	'<q cite=" a "></q><blockquote cite=" b "></blockquote><ins cite=" c "></ins>\n',
	'<script src=" a.js " for=" x "></script><head profile=" p "></head>\n',
	// white space and letters outside ASCII
	'<img srcset="a.jpg　 2x, b.jpg 1x">\n',
	'<img srcset="a.jpg　 2x ,  b.jpg  1.5x">\n',
	'<script>var a=1; // İK\n</script>\n<p>x</p>\n',
	'<style>/* İ */a{b:c}</style><p>x</p>\n',
	'<p class="a  b　c">x</p>\n',
	// layout the real pipeline produces
	'<!DOCTYPE html>\n<html lang="ja">\n\t<head>\n\t\t<meta charset="utf-8">\n\t\t<title>x</title>\n\t</head>\n\t<body>\n\t\t<p>hello</p>\n\t</body>\n</html>\n',
	'',
	'  \n',
	'text only',
];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
let errors = 0;
for (const [n, input] of cases.entries()) {
	let expected;
	try {
		expected = await v2Minify(input);
	} catch {
		expected = '__ERROR__';
		errors++;
	}
	writeFileSync(path.join(outDir, `${n}.in`), input);
	writeFileSync(path.join(outDir, `${n}.out`), expected);
}
process.stdout.write(
	`wrote ${cases.length} cases (${errors} rejected) to ${path.relative(root, outDir)}\n`,
);
