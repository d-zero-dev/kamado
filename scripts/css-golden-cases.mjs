/**
 * Hand-written style sheets for `kd_css`: one per rule family plus the
 * tricky inputs (hacks, odd comments, escapes, error recovery). Used for the
 * golden cases (`generate-css-golden.mjs`) and added to the random corpus
 * (`fuzz-css.mjs`).
 */

/** Declarations by rule family, wrapped in a rule. */
const declarationGroups = {
	colours: [
		'color:RED',
		'color:#FF0000',
		'color:#ff0000ff',
		'color:#f00f',
		'color:#abcdef',
		'color:#AABBCC',
		'color:rgb(255,0,0)',
		'color:rgb(255 0 0)',
		'color:rgb(255 0 0 / 50%)',
		'color:rgba(255,0,0,.5)',
		'color:rgba(0,0,0,0)',
		'color:rgb(10%,20%,30%)',
		'color:rgb(1.5,2.5,3.5)',
		'color:hsl(0,100%,50%)',
		'color:hsl(120deg 100% 50%)',
		'color:hsla(0,100%,50%,.5)',
		'color:hwb(0 0% 0%)',
		'color:transparent',
		'color:white',
		'color:lightgoldenrodyellow',
		'color:Black',
		'color:currentColor',
		'color:oklch(0.5 0.2 30)',
		'color:lab(50% 20 30)',
		'color:color-mix(in srgb, red 50%, blue)',
		'color:rgb(300,0,0)',
		'color:rgb( 255 , 0 , 0 )',
		'color:rgba(255,255,255,0.5)',
		'color:RGB(0,0,0)',
		'color:Red!important',
		'background:RED url(a.png)',
		'border:1px solid #FF0000',
		'box-shadow:0 0 0 1px RED',
		'filter:drop-shadow(0 0 1px #FFFFFF)',
		'font:12px RED',
		'animation-name:tan',
		'grid-area:gold',
	],
	numbers: [
		'margin:0px 0em 0rem 0%',
		'margin:0px 0 0px 0',
		'margin:1px 2px 1px 2px',
		'margin:1px 2px 3px 2px',
		'padding:1px 1px',
		'padding:1px 2px 1px',
		'border-width:1px 1px 1px 1px',
		'height:0%',
		'width:0%',
		'width:0.50px;height:+.5px;top:-0.0px;left:00.5em',
		'width:1.0px;height:1.50px;top:10.0%',
		'transition:all 500ms ease;animation-duration:1000ms;transition-delay:0.5s',
		'transform:rotate(360deg);transform:rotate(90deg);transform:rotate(0.5turn)',
		'width:calc(10.0px + 0.50em);height:calc(100% - 0px)',
		'width:calc( 100%   -   20px )',
		'opacity:1.5;opacity:-2;opacity:.50',
		'line-height:0px;stroke-width:0px;stroke-dashoffset:0px',
		'flex:1 1 0%;flex-basis:0px',
		'z-index:010;font-size:0px',
		'margin:1E3px;margin:1e-7px;width:1.5E+3px',
		'width:var(--x,0px)',
		'width:min(0px,1px);width:max(0.50px, 1.0px);width:clamp(0px,1.0px,2px)',
		'translate:0px 0px',
		'clip-path:polygon(0% 0%,100% 0%,100% 100%)',
		'background-position:0% 0%',
		'border-radius:0% 0%',
		'padding:0%',
		'transform:translate(0%,0%)',
	],
	'timing functions and transforms': [
		'transition:opacity .3s cubic-bezier(0.25,0.1,0.25,1)',
		'transition:opacity .3s cubic-bezier(0.42,0,1,1)',
		'animation:foo 1s steps(1,start) steps(1,end) steps(4,end)',
		'animation:foo 1s steps(4, jump-end)',
		'transform:translate(0,0);transform:translate(10px,0);transform:translate(0,10px);transform:translate3d(0,0,10px)',
		'transform:scale(1,1);transform:scale(2,1);transform:scale(1,2);transform:scale3d(1,1,2)',
		'transform:rotateZ(10deg);transform:rotate3d(0,0,1,10deg);transform:rotate3d(1,0,0,10deg)',
		'transform:matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,10,20,0,1)',
		'transform:translate(var(--x),0)',
	],
	'urls and strings': [
		'background:url( "a.png" )',
		"background:url('a.png')",
		'background:url(a b.png)',
		'background:url("a b.png")',
		'background:url("a(b).png")',
		'background:url(./a.png);background:url(a/../b.png)',
		'background:url()',
		'background:url("")',
		'background:url(data:image/png;base64,AAA=)',
		'background:url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\'></svg>")',
		'content:\'a\';content:"a\\"b";content:\'a"b\'',
		"content:'a\\'b';content:\"\\201C\"",
		"quotes:'«' '»'",
		'content:"a\\\nb"',
	],
	fonts: [
		'font-family:"Helvetica Neue",Arial,sans-serif;font-family:\'Open Sans\'',
		'font-family:"Arial","Arial"',
		'font-family:"1Arial"',
		'font-family:"Noto Serif JP",serif',
		'font-family:monospace,monospace',
		'font-weight:normal;font-weight:bold;font-weight:BOLD',
		'font:normal normal bold 12px/1.5 "Helvetica Neue", Arial',
		'font:italic small-caps bold 12px/30px Georgia,serif',
		'font:12px/1 var(--f)',
		'font:caption',
		'font-family:"KaTeX_SansSerif",serif',
		'font-family:"Noto Serif","Serif Pro",Georgia',
	],
	shorthands: [
		'display:block flow;display:inline flow-root;display:block flex;display:list-item block flow',
		'background-position:left top;background-position:top left;background-position:center center;background-position:0 0',
		'background-position:center left;background-position:left center;background-position:left',
		'background:url(a.png) no-repeat repeat;background-repeat:repeat no-repeat;background-repeat:no-repeat no-repeat',
		'background:url(a.png) left top / cover no-repeat',
		'unicode-range:U+0025-00FF,u+4??;unicode-range:U+0000-00FF',
		'border:1px solid red;border:solid 1px red;border:red 1px solid',
		'box-shadow:0 0 1px red inset;box-shadow:inset 0 0 1px red,0 1px 2px blue',
		'transition:1s opacity ease-in 2s',
		'animation:2s ease-in 1s infinite alternate both running foo',
		'columns:2 100px;column-rule:1px solid red',
		'flex-flow:wrap row;grid-area:1 / 2 / 3 / 4;grid-row:1/3;grid-column:span 2 / 3',
		'grid-template-areas:"a b" "c d"',
		'grid-template-columns:repeat(auto-fill,minmax(0px,1fr)) [end]',
		'border:none',
		'outline:none',
		'border-top:none',
		'background:none',
		'background:transparent',
		'outline:none!important',
		'border:0 none currentColor',
		'border:1px solid currentColor',
		'border:medium none',
	],
	gradients: [
		'background:linear-gradient(to top,red 0%,blue 100%)',
		'background:linear-gradient(to right,red,blue)',
		'background:linear-gradient(to left top,red,blue)',
		'background:linear-gradient(180deg,#FFF 0%,#000 100%)',
		'background:linear-gradient(red 50%,blue 40%)',
		'background:radial-gradient(circle at center,red 0%,blue 100%)',
		'background:-webkit-linear-gradient(top,red 0%,blue 100%)',
		'background:linear-gradient(to bottom,rgba(0,0,0,.5),transparent)',
		'background:conic-gradient(red 0%,blue 100%)',
	],
	'hacks, comments and custom properties': [
		'margin:0 auto!important;color:red ! important;color:red !IMPORTANT;color:red!important',
		'color:red;;;color:blue',
		"*zoom:1;_height:1px;color:red\\9;width:100px\\9;filter:progid:DXImageTransform.Microsoft.gradient(startColorstr='#80000000', endColorstr='#80000000')",
		'filter:alpha(opacity=50);-ms-filter:"progid:DXImageTransform.Microsoft.Alpha(Opacity=50)"',
		'width:expression(document.body.clientWidth > 800 ? "800px" : "auto")',
		'margin : 0   auto ;  padding:  1px   2px',
		'margin:0 /* c */ 1px;color:red/* c */',
		'margin:0/**/1px',
		'/* c */color/* c */:/* c */red/* c */',
		'--a:  1px  ;--b:#FFF;--c: calc( 1px  +  2px );--d:{a:b}',
		'--a:/* c */ 1px',
		'--empty:;--space: ;--json:{"a": [1, 2]}',
		'foo:0px;colour:RED;-x-margin:0px;composes:a b from "./x.css"',
		'-webkit-box-shadow:0 0 0px RED;*zoom:1.0;_height:0px',
		'--x: 0.50px;--y: RED;--z: url( "a.png" )',
		'width:calc(1px+2px)',
		'width:calc(1px + var(--a));margin:calc(-1 * var(--x))',
		'color:var(--a,#FFF)',
		'background:url(a.png)   no-repeat  ,  url(b.png)   repeat-x',
		'src:url("a.woff2") format("woff2"),url(\'a.woff\') format(\'woff\')',
		'will-change:transform , opacity',
		'transition:opacity .3s,transform .3s',
		'font-feature-settings:"liga" 1 , "kern" 1',
		'mask:url(a.svg#b) center / contain no-repeat',
	],
};

/** Whole style sheets by rule family. */
const sheetGroups = {
	'at-rules': [
		'@import url("a.css");\n@import "b.css" screen;\n@import url(c.css) screen and (min-width:100px);\na{b:c}\n',
		'@charset "utf-8";a{color:red}',
		'@charset "utf-8";a{content:"é"}',
		'a{content:"é"}@charset "utf-8";',
		'@media all{a{color:red}}',
		'@media all and (min-width:100px){a{color:red}}',
		'@media screen and (min-width : 100px) , print{a{color:red}}',
		'@media (min-width:100px) and (max-width:200px),(min-width:300px){a{color:red}}',
		'@media(min-width:100px){a{color:red}}',
		'@media   screen   and   (min-width:100px){a{color:red}}',
		'@media (min-aspect-ratio: 16/9){a{color:red}}',
		'@media (min-aspect-ratio: 32/18){a{color:red}}',
		'@media (width >= 600px) and (width <= 900px){a{color:red}}',
		'@media (400px <= width <= 700px){a{color:red}}',
		'@media not all and (monochrome){a{color:red}}',
		'@media only screen and (-webkit-min-device-pixel-ratio:1.5),only screen and (min-resolution:144dpi){a{color:red}}',
		'@supports (display:grid) and (not (display:inline-grid)){a{color:red}}',
		'@supports not (display : grid){a{color:red}}',
		'@supports (--css: variables){a{color:red}}',
		'@supports selector(:has(a)){a{color:red}}',
		'@container (min-width: 400px){a{color:red}}',
		'@container sidebar (min-width:400px) and (max-width:  500px){a{color:red}}',
		'@layer a,b;\n@layer a{a{color:red}}\n',
		'@layer a , b ;a{b:c}',
		'@layer a{}\n@layer a{a{b:c}}\n',
		'@layer a{@layer b{c{d:e}}}',
		'@font-face{font-family:"A";src:url("a.woff2") format("woff2"),url(\'a.woff\') format(\'woff\');font-display:swap;unicode-range:U+0000-00FF,U+0131}',
		'@keyframes x{from{a:b}to{a:c}}',
		'@keyframes x{0%{a:b}100%{a:c}}',
		'@keyframes x{from{a:b}to{a:c}}@keyframes x{from{a:d}to{a:e}}',
		'@-webkit-keyframes x{from{a:b}}@keyframes x{from{a:b}}',
		'@keyframes x{50%,0%{a:b}}',
		'@keyframes x{0%{width:0%;stroke-dasharray:0%}to{width:100%}}',
		'@page :first{margin:0px}',
		'@page{@top-left{content:"a"}}',
		"@property --x{syntax:'<length>';inherits:false;initial-value:0px}",
		"@property --p{syntax:'<percentage>';inherits:false;initial-value:0%}",
		'@namespace svg url(http://www.w3.org/2000/svg);\n@namespace url(http://www.w3.org/1999/xhtml);\n',
		'@counter-style x{system:cyclic;symbols:"a"}',
		'@font-feature-values Font One{@styleset{nice-style:12}}',
		'@unknown foo  bar {a   :  b  ;  c:d}',
		'@media print{@media (min-width:1px){a{b:c}}}',
	],
	'duplicates and empty rules': [
		'a{color:red}a{color:red}',
		'a{color:red;margin:0}b{x:y}a{color:red}',
		'a{color:red}b{color:blue}a{color:red}',
		'@media a{a{b:c}}@media a{a{b:c}}',
		'a{b:c}@media a{a{b:c}}',
		'a,b{x:y}b,a{x:y}a,a{x:y}',
		'a{}\na{;}\n@media screen{}\n@media screen{a{}}\na{color:red}b{}\n@font-face{}\n',
	],
	selectors: [
		'a b > c + d ~ e{x:y}',
		'a>b+c~d{x:y}',
		'a   >   b{x:y}\na ,  b{x:y}\n',
		'a:not(.b,.c):is(.d, .e){x:y}',
		'a:not(.b,.b){x:y}',
		'a:nth-child(1){x:y}a:nth-child(2n+1){x:y}a:nth-child(even){x:y}a:nth-child( 2n + 1 ){x:y}',
		'a:nth-child(2n+1 of .b){x:y}a:nth-last-child(1){x:y}a:nth-of-type(1){x:y}a:nth-child(n+2){x:y}',
		'a::before{x:y}a::after,a::first-line{x:y}a::selection{x:y}a:BEFORE{x:y}',
		'*.a{x:y}*{x:y}* a{x:y}a *{x:y}*:hover{x:y}a>*{x:y}*|*{x:y}',
		'a[href="x"]{x:y}a[href=\'x\']{x:y}a[ href = "x" ]{x:y}a[href="x y"]{x:y}a[href="1x"]{x:y}a[href=""]{x:y}',
		'a[href="x" i]{x:y}a[href=x i]{x:y}a[href^="http"]{x:y}a[data-a="a-b"]{x:y}a[data-a="a_b"]{x:y}',
		'a[href~="x"]{x:y}a[href|=x]{x:y}a[lang|="en"]{x:y}',
		'.a\\:b{x:y}.a\\31 b{x:y}.\\31 0{x:y}',
		'a  .b{x:y}a:hover,a:focus{x:y}html>/**/body{x:y}',
		'a\n\tb{x:y}',
	],
	'nesting and comments': [
		'.a{&:hover{x:y}}.a{& .b{x:y}}.a{&.b{x:y}}.a{.b &{x:y}}',
		'.a{> .b{x:y}}.a{+ .b{x:y}}',
		'.a{color:red;&:hover{color:blue}}',
		'.a{color:red;@media (min-width:1px){color:blue}}',
		'.a{@media (min-width:1px){color:blue}}',
		'.a{& > .b{x:y} .c{x:y}}',
		':root{--a:  1px  ;--b:#FFF;--c: calc( 1px  +  2px );--d:{a:b}}',
		'/*! keep */a{x:y}',
		'/* drop */a{x:y}/*! keep2 */',
		'a{x:y;/*! keep */}',
		'a{}/*! keep */',
		'@media screen{/*! keep */a{x:y}}',
	],
	'error recovery': [
		'a{color:red',
		'a{color:red;',
		'a{color:"red',
		'a{color:red}}',
		'a{b:c}}d{e:f}',
		'a{b:c};d{e:f}',
		'a{b:c}\n;\nd{e:f}',
		'a{b',
		'a{b:}',
		'a{:c}',
		'a{b:c;d}',
		'a{b:c;;d:e}',
		'a{b:c d:e}',
		'/* unterminated',
		'a{b:c}/* unterminated',
		'@media screen{a{b:c}',
		'@media screen',
		'@import "a"',
		'@import "a";',
		'a{b:url(x',
		'a{b:url("x}',
		'a{b:(c}d:e}',
		'<!-- a{b:c} -->',
		'a{b:c}<!--d{e:f}-->',
		'a{b:c !important !important}',
		'a{b:c!ie}',
		'a{b:c\\}',
		'a{b:c\\;d:e}',
		'a{b:\\}}',
		'a { b : c ; } ; b { c : d }',
		'}a{b:c}',
		'{a:b}',
		'a{{b:c}}',
		'a{b{c:d}e:f}',
		'a b{c:d}\ne{f:g}',
		'@font-face{font-family:a;src:url(a)}@font-face{font-family:a;src:url(a)}',
		'',
		'   \n  ',
		'/**/',
		'\uFEFFa{b:c}',
		'a{b:c}\r\nd{e:f}\r\n',
		'a{b:c\u00A0d}',
		'a{content:"\u00E9\u3042"}b{c:d}',
		'.\u3042{b:c}',
		'a{b:c}\u0000d{e:f}',
	],
};

/**
 * The hand-written cases by rule family, each a style sheet. A declaration
 * is a case twice: on one line, and spread over lines in a rule.
 * @returns {Record<string, string[]>} The style sheets by family
 */
export function cssCaseGroups() {
	/** @type {Record<string, string[]>} */
	const groups = {};
	for (const [name, list] of Object.entries(declarationGroups)) {
		groups[name] = list.flatMap((d) => [
			`a{${d}}`,
			`.a {\n\t${splitDeclarations(d).join(';\n\t')};\n}\n`,
		]);
	}
	for (const [name, list] of Object.entries(sheetGroups)) {
		// cssnano merges adjacent rules with the same declarations (kd_css
		// does not): the rules of the selector and nesting cases get declarations
		// of their own, so that they stay separate rules.
		groups[name] =
			name === 'selectors' || name === 'nesting and comments'
				? list.map(distinct)
				: [...list];
	}
	return groups;
}

/**
 * Gives each `{x:y}` of a style sheet a value of its own: `{x:1}`, `{x:2}`...
 * @param {string} sheet - The style sheet
 * @returns {string} The style sheet
 */
function distinct(sheet) {
	let n = 0;
	return sheet.replaceAll('{x:y}', () => `{x:${++n}}`);
}

/**
 * Splits declarations at the semicolons outside strings and parentheses.
 * @param {string} text - Declarations
 * @returns {string[]} The declarations
 */
function splitDeclarations(text) {
	const out = [];
	let depth = 0;
	let quote = '';
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			if (c === '\\') {
				i++;
			} else if (c === quote) {
				quote = '';
			}
		} else
			switch (c) {
				case '"':
				case "'": {
					quote = c;

					break;
				}
				case '(': {
					depth++;

					break;
				}
				case ')': {
					depth--;

					break;
				}
				default: {
					if (c === ';' && depth === 0) {
						out.push(text.slice(start, i));
						start = i + 1;
					}
				}
			}
	}
	out.push(text.slice(start));
	return out;
}

/**
 * Every hand-written case as a style sheet.
 * @returns {string[]} The style sheets
 */
export function cssCases() {
	return Object.values(cssCaseGroups()).flat();
}

/**
 * The declarations of the hand-written cases, each as the text of a `style`
 * attribute (a case of several declarations stays one attribute).
 * @returns {string[]} The declaration lists
 */
export function declarationCases() {
	return Object.values(declarationGroups).flat();
}
