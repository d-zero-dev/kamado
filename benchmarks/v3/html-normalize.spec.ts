import { describe, expect, test } from 'vitest';

import { normalizeHtml } from './html-normalize.ts';

const same = (a: string, b: string) =>
	expect(normalizeHtml(a).markup).toBe(normalizeHtml(b).markup);
const differ = (a: string, b: string) =>
	expect(normalizeHtml(a).markup).not.toBe(normalizeHtml(b).markup);

describe('normalizeHtml', () => {
	test('the order of the attributes and their quotes do not matter', () => {
		same('<img src="a.png" width=10 alt=\'x\'>', '<img alt="x" width="10" src="a.png">');
	});

	test('the case of tag and attribute names does not matter', () => {
		same('<DIV Class="a">x</DIV>', '<div class="a">x</div>');
	});

	test('a ">" inside a quoted attribute value is part of the value', () => {
		const { markup } = normalizeHtml('<a title="a>b" href="/">x</a>');
		expect(markup).toContain('title="a&gt;b"');
		same('<a title="a>b" href="/">x</a>', '<a href="/" title="a&gt;b">x</a>');
	});

	test('character references in text are compared as the characters they stand for', () => {
		same('<p>a&nbsp;b</p>', '<p>a&#160;b</p>');
		same('<p>a&#xA0;b</p>', '<p>a b</p>');
		same('<p>D&amp;I</p>', '<p>D&#38;I</p>');
	});

	test('"&amp;" in an attribute value is the same as "&"', () => {
		same('<a href="/?a=1&amp;b=2">x</a>', '<a href="/?a=1&b=2">x</a>');
	});

	test('an escaped tag in text stays text', () => {
		differ('<p>&lt;b&gt;x&lt;/b&gt;</p>', '<p><b>x</b></p>');
	});

	test('a raw "&" that is not a reference stays as written', () => {
		same('<p>a & b</p>', '<p>a &amp; b</p>');
		same('<p>&unknown;</p>', '<p>&amp;unknown;</p>');
	});

	test('whitespace at the boundaries of block elements is not rendered', () => {
		same('<div>\n  <p>\n    x\n  </p>\n</div>', '<div><p>x</p></div>');
		same('<ul>\n\t<li>a</li>\n\t<li>b</li>\n</ul>', '<ul><li>a</li><li>b</li></ul>');
	});

	test('runs of whitespace collapse to one space', () => {
		same('<p>a\n   b</p>', '<p>a b</p>');
	});

	test('whitespace between inline elements is rendered and is kept', () => {
		differ('<p><a>x</a> <a>y</a></p>', '<p><a>x</a><a>y</a></p>');
		same('<p><a>x</a>\n<a>y</a></p>', '<p><a>x</a> <a>y</a></p>');
	});

	test('whitespace inside pre is kept as written', () => {
		differ('<pre>a\n  b</pre>', '<pre>a b</pre>');
	});

	test('one newline right after the start tag of pre is dropped, as the parser does', () => {
		same('<pre>\na</pre>', '<pre>a</pre>');
		differ('<pre>\n\na</pre>', '<pre>a</pre>');
	});

	test('a newline written as a reference after the start tag of pre is kept', () => {
		differ('<pre>&#10;x</pre>', '<pre>x</pre>');
		differ('<textarea>&#10;x</textarea>', '<textarea>x</textarea>');
		same('<textarea>\nx</textarea>', '<textarea>x</textarea>');
	});

	test('a head that is closed by the body content does not swallow its whitespace', () => {
		differ(
			'<head><title>t</title><p><a>x</a> <a>y</a></p>',
			'<head><title>t</title><p><a>x</a><a>y</a></p>',
		);
		same('<head><title>t</title><p>x</p>', '<head><title>t</title></head><p>x</p>');
	});

	test('the contents of xmp, iframe, noembed and noframes are raw text', () => {
		differ('<xmp><b>x</b></xmp>', '<xmp><b>x</b> </xmp>');
		same('<xmp>a<b></xmp>', '<xmp>a<b></xmp>');
		const { markup } = normalizeHtml('<iframe><p>x</p></iframe>');
		expect(markup).toContain('<p>x</p>');
		expect(markup).not.toContain('\n<p>\n');
	});

	test('title and style inside svg are elements of svg, not raw text', () => {
		const { inline } = normalizeHtml(
			'<svg><style>.a{fill:red}</style><title>a&amp;b</title></svg>',
		);
		expect(inline.styles).toEqual([]);
		same('<svg><title>a&amp;b</title></svg>', '<svg><title>a&b</title></svg>');
	});

	test('whitespace at the start and end inside a button is not rendered', () => {
		same('<button>\n  x\n</button>', '<button>x</button>');
	});

	test('whitespace inside a label is rendered, since a label is inline', () => {
		differ('Name<label> First</label>', 'Name<label>First</label>');
	});

	test('an element that is not rendered is not a block boundary', () => {
		differ('<p>a <script>x()</script>b</p>', '<p>a<script>x()</script>b</p>');
		differ('<p>a <meta itemprop="x">b</p>', '<p>a<meta itemprop="x">b</p>');
	});

	test('whitespace between the elements of the head is not rendered', () => {
		same(
			'<html><head>\n  <meta charset="utf-8">\n  <title>t</title>\n</head><body>x</body></html>',
			'<html><head><meta charset="utf-8"><title>t</title></head><body>x</body></html>',
		);
	});

	test('a name on the prototype of Object is not a character reference', () => {
		same('<p>&constructor;</p>', '<p>&amp;constructor;</p>');
	});

	test('a self-closing slash on an HTML element is ignored', () => {
		same('<br/><img src="a"/>', '<br><img src="a">');
		same('<div/>x</div>', '<div>x</div>');
	});

	test('a self-closing slash inside svg closes the element', () => {
		same('<svg><path d="M0"/></svg>', '<svg><path d="M0"></path></svg>');
	});

	test('the keyword of the doctype is compared without case', () => {
		same('<!DOCTYPE html><p>x</p>', '<!doctype html><p>x</p>');
		differ(
			'<!doctype html PUBLIC "-//W3C//DTD HTML 4.01//EN"><p>x</p>',
			'<!doctype html><p>x</p>',
		);
	});

	test('an attribute with no value is the same as an empty value', () => {
		same('<input disabled>', '<input disabled="">');
	});

	test('the contents of script and style are taken out of the markup', () => {
		const a = normalizeHtml(
			'<p>x</p><script>var a = 1;</script><style>a { color: red }</style>',
		);
		const b = normalizeHtml(
			'<p>x</p><script>var a=1</script><style>a{color:red}</style>',
		);
		expect(a.markup).toBe(b.markup);
		expect(a.inline.scripts).toEqual(['var a = 1;']);
		expect(b.inline.scripts).toEqual(['var a=1']);
		expect(a.inline.styles).toEqual(['a { color: red }']);
	});

	test('a closing tag of another element inside a script does not end it', () => {
		const { markup, inline } = normalizeHtml(
			'<script>document.write("</div>")</script><p>x</p>',
		);
		expect(inline.scripts).toEqual(['document.write("</div>")']);
		expect(markup).toContain('<p>');
	});

	test('the value of a style attribute is taken out as inline CSS', () => {
		const a = normalizeHtml('<p style="color: red">x</p>');
		const b = normalizeHtml('<p style="color:red">x</p>');
		expect(a.markup).toBe(b.markup);
		expect(a.inline.styles).toEqual(['color: red']);
		expect(b.inline.styles).toEqual(['color:red']);
	});

	test('the text of a textarea is compared with its references decoded', () => {
		same('<textarea>a&amp;b</textarea>', '<textarea>a&b</textarea>');
	});

	test('the elements with an empty class attribute are listed and left out of the markup', () => {
		const a = normalizeHtml('<ul class=""><li class="">x</li></ul>');
		const b = normalizeHtml('<ul><li>x</li></ul>');
		expect(a.markup).toBe(b.markup);
		expect(a.emptyClass).toEqual([0, 1]);
		expect(b.emptyClass).toEqual([]);
	});

	test('a class of only whitespace is not an empty class', () => {
		differ('<p class="">x</p>', '<p class=" ">x</p>');
		expect(normalizeHtml('<p class=" ">x</p>').emptyClass).toEqual([]);
		same('<p class=" ">x</p>', '<p class="\n">x</p>');
	});

	test('CR LF and CR are read as LF, as the parser does', () => {
		same('<pre>a\r\nb\rc</pre>', '<pre>a\nb\nc</pre>');
		expect(normalizeHtml('<script>a\r\nb</script>').inline.scripts).toEqual(['a\nb']);
	});

	test('an empty class attribute on another element is told apart', () => {
		const a = normalizeHtml('<ul class=""><li>x</li></ul><p>y</p>');
		const b = normalizeHtml('<ul><li>x</li></ul><p class="">y</p>');
		expect(a.markup).toBe(b.markup);
		expect(a.emptyClass).not.toEqual(b.emptyClass);
	});

	test('the markup is one token per line in a fixed form', () => {
		expect(normalizeHtml('<P CLASS=a>x&nbsp;y</P>').markup).toBe(
			'<p class="a">\nx&nbsp;y\n</p>',
		);
		expect(
			normalizeHtml(
				'<!DOCTYPE html>\n<html>\n<head>\n<title> t </title>\n</head>\n<body><p>a <b>b</b></p></body></html>',
			).markup,
		).toBe(
			'<!doctype html>\n<html>\n<head>\n<title>\nt\n</title>\n</head>\n<body>\n<p>\na \n<b>\nb\n</b>\n</p>\n</body>\n</html>',
		);
	});

	test('whitespace collapses across comments, hidden elements and inline tags', () => {
		same('<p>a <!-- c --> b</p>', '<p>a <!-- c -->b</p>');
		same('<p>a <b> c</b></p>', '<p>a <b>c</b></p>');
		same(
			'<div><span>x</span>\n<script>a</script>\n</div>',
			'<div><span>x</span><script>a</script></div>',
		);
		same('<p><span>x </span></p>', '<p><span>x</span></p>');
	});

	test('whitespace does not collapse across a replaced element', () => {
		differ('<p>a <img src="i"> b</p>', '<p>a <img src="i">b</p>');
		differ('<p>a <br>b</p>', '<p>a<br>b</p>');
	});

	test('the whitespace of a select is judged as an inline block', () => {
		same(
			'<select>\n<option>a</option>\n</select>',
			'<select><option>a</option></select>',
		);
		differ('a<select></select>', 'a <select></select>');
	});

	test('listing and plaintext keep their whitespace', () => {
		differ('<listing>a  b</listing>', '<listing>a b</listing>');
		differ('<plaintext>a  b', '<plaintext>a b');
	});

	test('a self-closing svg closes itself', () => {
		same('<p><svg/>x</p>', '<p><svg></svg>x</p>');
	});

	test('the first of two attributes with the same name wins', () => {
		same('<p id="a" id="b">x</p>', '<p id="a">x</p>');
		differ('<p id="a" id="b">x</p>', '<p id="b">x</p>');
	});

	test('an unquoted attribute value can contain a slash', () => {
		expect(normalizeHtml('<a href=/a/b>x</a>').markup).toContain('href="/a/b"');
	});

	test('numeric references follow the parser', () => {
		same('<p>&#150;</p>', '<p>–</p>');
		same('<p>&#0;&#xD800;&#x110000;</p>', '<p>���</p>');
	});

	test('a named reference without its semicolon stays as written', () => {
		differ('<p>&amp b</p>', '<p>& b</p>');
	});

	test('the whitespace of the doctype is collapsed', () => {
		same('<!DOCTYPE  html\n>', '<!doctype html>');
	});

	test('an empty comment ends where it starts', () => {
		const { markup } = normalizeHtml('<!--><p>x</p><!---><p>y</p>-->');
		expect(markup).toContain('<p>\nx\n</p>');
		expect(markup).toContain('<p>\ny\n</p>');
	});

	test('a CDATA section inside svg is read up to its end', () => {
		expect(normalizeHtml('<svg><![CDATA[a>b]]></svg>').markup).toContain(
			'<![CDATA[a>b]]>',
		);
	});

	test('the whitespace inside a class value is collapsed', () => {
		same('<p class=" a  b ">x</p>', '<p class="a b">x</p>');
		differ('<p class="a b">x</p>', '<p class="b a">x</p>');
	});

	test('comments and processing instructions are kept as written', () => {
		differ('<!-- a --><p>x</p>', '<!-- b --><p>x</p>');
		const { markup } = normalizeHtml('<?php echo "a>b"; ?><p>x</p>');
		expect(markup).toContain('<?php echo "a>b"; ?>');
	});

	test('different text is different', () => {
		differ('<p>a</p>', '<p>b</p>');
	});
});
