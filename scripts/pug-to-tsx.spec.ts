import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

// The converter is run on a small project, as it is run on a real one. It reads the Pug
// code with the packages of the project (`pug-lexer`, `pug-parser`, `acorn`; this
// repository has them as devDependencies, so the test project links them) and the tables
// of a build of kamado, so the test is skipped before `yarn build`.
const repo = path.resolve(import.meta.dirname, '..');
const dist = path.join(repo, 'packages', 'kamado', 'dist', 'jsx');
const available =
	existsSync(path.join(dist, 'attr-table.js')) &&
	existsSync(path.join(dist, 'runtime.d.ts'));

const FILES: Record<string, string> = {
	'__assets/htdocs/index.pug': `include /mixin/m.pug
- var lang = "en"
html(lang="ja")
	head
		meta(charset="UTF-8")
		title t
	body
		button(type="button" onclick="return false;" tabindex="-1") b
		table(border="0")
			tr
				td(colspan="2" style="color: red") c
		time(datetime="2026-01-02") d
		a(href="/x/" target=lang === "en" ? "_blank" : false rel=lang === "en" ? "noopener" : null) a
		input(maxlength="255" size="10" disabled=lang === "en" ? true : null)
		p(hidden="until-found") h
		- var on = true
		- var off = false
		div(data-x=true data-y=false aria-hidden=true aria-pressed=false data-z=on ? true : undefined data-w=off ? true : undefined data-n=0)
		div(hidden=on draggable=true spellcheck=false contenteditable=on)
		input(value=lang)
		link(⚠️="note" rel="stylesheet" href="/a.css")
		div(@click="go" :foo="x" 日本語="y" $foo="z")
		p tbody > tr
		if !off
			p negation
		if lang === "en" || lang === "ja"
			p comparison
		if items
			p any
		each item, index in items
			span= item
		each item in items
			span x
		each v, k in { a: "item", b: "label" }
			p #{k}=#{v}
		each v, i in ["x", "y"]
			p #{i}=#{v}
		- const sources = { a: 1 }
		p= sources.a
		each v in sources
			p= v
		else
			p none
		p= "x => y"
		- const fn = items.map(x => x)
		+a
		+card({ lang })
		include /component/c-static.pug
		include /data/frag.html
		script(type="application/ld+json").
			{
			  "a": 1
			}
		script.
			var a = 1;

			var b = 2;
		style.
			.a { color: red; }
			.b { color: blue; }
		script
			| var p = 1;
			| var q = 2;
		pre.
			line1
			  indented
			line3
		pre
			| a
			| b
		textarea.
			x
			  y
		pre
			| &lt;b&gt; a
		pre
			code.
				c1
				  c2
`,
	'__assets/_libs/mixin/m.pug': `mixin a
	p A
mixin b
	p B
mixin card({ lang = "ja" } = {})
	p= lang
`,
	'__assets/_libs/component/c-static.pug': `.c-static static
`,
	'__assets/_libs/mixin/k.pug': `- const X = { a: "item", b: "label" }
- const FROM = fromPage
- const PAIR = [X.a, X.b]
- const FROM_BLOCK = locals["x"]
- const UNUSED = { z: 1 }
- function pick(key) { return X[key] }
mixin lookup(k)
	p= X[k]
	p= pick(k)
mixin pair
	p= PAIR
mixin fromPageOnly
	p= FROM
`,
	'__assets/_libs/mixin/r.pug': `mixin reassign(options, size = 1)
	- options = options || {}
	- size += 1
	p= options.label
	p= size
mixin reassignPattern({ label = "a" } = {})
	- label = label + "b"
	p= label
mixin splitPattern({ label = "a", size } = {})
	- label = label + "b"
	p= label
	p= size
mixin splitNested(first, { head: { title, sub = 1 }, tail }, last = first)
	- title = title + "!"
	p= title
	p= sub
	p= tail
	p= last
mixin restPattern({ id, ...rest })
	- id = id + 1
	p= id
	p= rest.name
mixin restAssigned({ a, b = 1, ...others })
	- others = { ...others, b }
	p= a
	p= others.name
mixin restReader({ a, b = a, ...others })
	- a = a + 1
	p= b
	p= others.name
mixin restTaken({ id, _id, ...others })
	- id = id + _id
	p= id
	p= others.name
mixin restNested({ head: { title, sub }, ...others })
	- title = title + "!"
	p= title
	p= sub
	p= others.name
mixin nestedDefault({ head: { title, sub } = {}, tail })
	- title = title + "!"
	p= title
	p= sub
	p= tail
mixin shorthandDefault({ a, b = { a }, ...r })
	- a = a + 1
	p= b
	p= r.name
mixin functionDefault({ a, b = () => a, ...r })
	- a = a + 1
	p= b
	p= r.name
mixin blockDefault({ a, b = () => { const a = 1; return a }, ...r })
	- a = a + 1
	p= b
	p= r.name
mixin paramDefault({ a, b = (a = 0) => a, ...r })
	- a = a + 1
	p= b
	p= r.name
mixin computedKey({ ["x"]: { a, b } })
	- a = a + 1
	p= b
mixin guard(label)
	- if (!label) label = "x"
	p= label
mixin swap(a, b)
	- [a, b] = [b, a]
	p= a
mixin partial(a, b = 2, options)
	- options = options || {}
	p= a
	p= b
	p= options.label
mixin chained(a, b = a, c)
	- a = a + 1
	p= b
	p= c
mixin keep(label)
	p= label
mixin list(items)
	each v in items
		p= v
mixin table(rows)
	each v, k in rows
		p #{k}=#{v}
`,
	// What a `pre` calls or includes: a mixin, the block of a call, a file, a file of
	// mixins that also writes markup, and a mixin that calls another one in its own `pre`.
	'__assets/htdocs/pre.pug': `include /mixin/p.pug
include /component/c-both.pug
html
	body
		pre
			+sample
		pre
			+wrap
				| w1
				|   w2
		pre
			include /component/c-text.pug
		pre
			include /component/c-both.pug
		pre
			include /component/c-extends.pug
		+sample
		+holder
`,
	'__assets/_libs/layout/base.pug': `html
	body
		block content
`,
	'__assets/htdocs/pre-child.pug': `extends /layout/base.pug
mixin local
	| l1
	|   l2
block content
	pre
		+local
`,
	'__assets/_libs/mixin/p.pug': `mixin sample
	| line1
	|   indented
	| line3
mixin wrap
	block
mixin holder
	pre
		+sample
`,
	'__assets/_libs/component/c-text.pug': `| s1
|   s2
`,
	'__assets/_libs/component/c-both.pug': `mixin tag
	| t1
	|   t2
| b1
|   b2
`,
	'__assets/_libs/component/c-extends.pug': `extends /layout/base.pug
mixin xm
	| m1
	|   m2
block content
	| x1
	|   x2
	+xm
`,
	'__assets/_libs/data/frag.html': '<hr>\n',
	'package.json': '{ "name": "fixture", "private": true }\n',
};

// CI builds first, so there a missing build fails the tests instead of skipping them.
describe.skipIf(!available && !process.env.CI)(
	'pug-to-tsx.mjs on a small project',
	() => {
		let root: string;
		let out: string;
		let stdout: string;
		const read = (file: string) => readFileSync(path.join(out, file), 'utf8');

		beforeAll(() => {
			root = mkdtempSync(path.join(tmpdir(), 'pug-to-tsx-'));
			const project = path.join(root, 'project');
			out = path.join(root, 'out');
			for (const [file, text] of Object.entries(FILES)) {
				mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
				writeFileSync(path.join(project, file), text);
			}
			// The converter finds the Pug packages from the project.
			symlinkSync(path.join(repo, 'node_modules'), path.join(project, 'node_modules'));
			stdout = execFileSync(
				process.execPath,
				[path.join(repo, 'scripts', 'pug-to-tsx.mjs'), project, out],
				{ encoding: 'utf8', stdio: 'pipe' },
			);
		}, 60_000);

		afterAll(() => {
			rmSync(root, { recursive: true, force: true });
		});

		test('spells the attributes as React does, and as the types ask for', () => {
			const page = read('__assets/htdocs/index.tsx');
			expect(page).toContain('<time dateTime="2026-01-02">');
			expect(page).toContain('<td colSpan={2} ');
			expect(page).toContain('<meta charSet="UTF-8" />');
		});

		test('writes a string of digits as a number where the types take a number', () => {
			const page = read('__assets/htdocs/index.tsx');
			expect(page).toContain('tabIndex={-1}');
			expect(page).toContain('<table border={0}>');
			expect(page).toContain('<input maxLength={255} size={10} ');
		});

		test('keeps an event handler in its place, outside of the types', () => {
			expect(read('__assets/htdocs/index.tsx')).toContain(
				'<button type="button" {...({ "onclick": "return false;" } as any)} tabIndex={-1}>',
			);
		});

		test('gives the text of a style, and a value that the types lack, a cast', () => {
			const page = read('__assets/htdocs/index.tsx');
			expect(page).toContain('style={("color: red") as any}');
			expect(page).toContain('hidden={"until-found" as any}');
		});

		test('writes the false and the null of a branch as undefined', () => {
			const page = read('__assets/htdocs/index.tsx');
			expect(page).toContain('target={lang === "en" ? "_blank" : undefined}');
			expect(page).toContain('rel={lang === "en" ? "noopener" : undefined}');
			// A boolean prop: its null is changed as well.
			expect(page).toContain('disabled={lang === "en" ? true : undefined}');
		});

		test('writes a true of data-*, aria-* and draggable as an empty attribute, and a false as none', () => {
			const page = read('__assets/htdocs/index.tsx');
			const toEmpty = (name: string, value: string) =>
				`${name}={((v: any) => (v === true ? "" : v === false ? undefined : v))(${value})}`;
			expect(page).toContain(toEmpty('data-x', 'true'));
			expect(page).toContain(toEmpty('data-y', 'false'));
			expect(page).toContain(toEmpty('aria-hidden', 'true'));
			expect(page).toContain(toEmpty('aria-pressed', 'false'));
			expect(page).toContain(toEmpty('data-z', 'on ? true : undefined'));
			expect(page).toContain(toEmpty('data-w', 'off ? true : undefined'));
			expect(page).toContain(toEmpty('data-n', '0'));
			expect(page).toContain(toEmpty('draggable', 'true'));
			expect(page).toContain(toEmpty('spellCheck', 'false'));
			expect(page).toContain(toEmpty('contentEditable', 'on'));
		});

		test('keeps the true of a boolean prop, which React writes as an empty attribute', () => {
			expect(read('__assets/htdocs/index.tsx')).toContain('hidden={on}');
		});

		test('leaves the value prop, which takes any text, as it is', () => {
			expect(read('__assets/htdocs/index.tsx')).toContain('<input value={lang} />');
		});

		test('warns of each attribute name that the runtime does not write', () => {
			const note =
				'is not written by the runtime (as React does not): write the element with html() or html.inject';
			expect(stdout).toContain(
				`warning: __assets/htdocs/index.pug: the attribute "⚠️" of <link> ${note}`,
			);
			expect(stdout).toContain(
				`warning: __assets/htdocs/index.pug: the attribute "@click" of <div> ${note}`,
			);
			expect(stdout).toContain(
				`warning: __assets/htdocs/index.pug: the attribute "$foo" of <div> ${note}`,
			);
		});

		test('does not warn of a name that the runtime writes', () => {
			expect(stdout).not.toContain('":foo"');
			expect(stdout).not.toContain('"日本語"');
		});

		test('keeps the attribute with a name that JSX cannot write in a spread, as it was', () => {
			const page = read('__assets/htdocs/index.tsx');
			expect(page).toContain('{...({ "⚠️": "note" } as any)}');
			expect(page).toContain(
				'<div {...({ "@click": "go", ":foo": "x", "日本語": "y", "$foo": "z" } as any)}>',
			);
		});

		test('keeps the line breaks of a script and a style block as they are written', () => {
			const page = read('__assets/htdocs/index.tsx');
			expect(page).toContain('__html: "{\\n  \\"a\\": 1\\n}"');
			expect(page).toContain('__html: "var a = 1;\\n\\nvar b = 2;"');
			expect(page).toContain('__html: ".a { color: red; }\\n.b { color: blue; }"');
			// The lines of the form with pipes are joined by one line break.
			expect(page).toContain('__html: "var p = 1;\\nvar q = 2;"');
		});

		test('keeps the line breaks and the indentation of a pre and a textarea as strings', () => {
			const page = read('__assets/htdocs/index.tsx');
			const lines = (s: string) => s.split('\n').map((l) => l.trim());
			const block = (open: RegExp, close: string) => {
				const start = page.search(open);
				return lines(page.slice(start, page.indexOf(close, start) + close.length));
			};
			// `pre.`: the common indentation is dropped, the relative one stays, and each
			// line break is a text node of its own.
			expect(block(/<pre>\s*\{"line1"\}/, '</pre>')).toEqual([
				'<pre>',
				'{"line1"}',
				'{"\\n"}',
				'{"  indented"}',
				'{"\\n"}',
				'{"line3"}',
				'</pre>',
			]);
			// The lines of the form with pipes.
			expect(block(/<pre>\s*\{"a"\}/, '</pre>')).toEqual([
				'<pre>',
				'{"a"}',
				'{"\\n"}',
				'{"b"}',
				'</pre>',
			]);
			expect(block(/<textarea>/, '</textarea>')).toEqual([
				'<textarea>',
				'{"x"}',
				'{"\\n"}',
				'{"  y"}',
				'</textarea>',
			]);
			// A tag inside of a pre is still inside of it.
			expect(block(/<code>/, '</code>')).toEqual([
				'<code>',
				'{"c1"}',
				'{"\\n"}',
				'{"  c2"}',
				'</code>',
			]);
			// An entity is passed on as it is: a string would show the `&`.
			expect(page).toContain('{html("&lt;b&gt; a")}');
		});

		test('keeps the line breaks of what a pre calls or includes, with a component for it', () => {
			const page = read('__assets/htdocs/pre.tsx');
			const mixins = read('__assets/_libs/mixin/p.tsx');
			const lines = (s: string) => s.split('\n').map((l) => l.trim());
			const component = (source: string, name: string) => {
				const start = source.indexOf(`function ${name}(`);
				return lines(source.slice(start, source.indexOf('\n}', start) + 2));
			};
			// A mixin called in a pre is the component that writes its text as strings, and
			// the same call outside of one is still the plain component.
			expect(page).toContain('<SamplePre {...props} />');
			expect(page).toContain('<Sample {...props} />');
			expect(component(mixins, 'SamplePre').slice(2, 9)).toEqual([
				'<>',
				'{"line1"}',
				'{"\\n"}',
				'{"  indented"}',
				'{"\\n"}',
				'{"line3"}',
				'</>',
			]);
			expect(component(mixins, 'Sample')).toContain("{' '}");
			// The block of a call was already inside of the pre.
			expect(page).toContain('<WrapPre {...props}>');
			// A mixin that calls another in its own pre.
			expect(component(mixins, 'Holder')).toContain('<SamplePre {...props} />');
			// An include is a component of its own file, named in the import.
			expect(page).toContain('<CTextPre {...props} />');
			expect(read('__assets/_libs/component/c-text.tsx')).toContain(
				'export function CTextPre(',
			);
			expect(
				component(read('__assets/_libs/component/c-text.tsx'), 'CTextPre'),
			).toContain('{"  s2"}');
			// A file of mixins that also writes markup: the body and the mixins.
			expect(page).toContain('<CBothBodyPre {...props} />');
			const both = read('__assets/_libs/component/c-both.tsx');
			expect(component(both, 'CBothBodyPre')).toContain('{"  b2"}');
			// A mixin that a page writes itself, in the module of the page.
			const child = read('__assets/htdocs/pre-child.tsx');
			expect(child).toContain('<LocalPre {...props} />');
			expect(component(child, 'LocalPre')).toContain('{"  l2"}');
			// A file that extends a layout: the slots of the component for a pre are strings.
			expect(page).toContain('<CExtendsPre {...props} />');
			const extending = read('__assets/_libs/component/c-extends.tsx');
			expect(component(extending, 'CExtendsPre')).toContain('{"  x2"}');
			expect(component(extending, 'CExtends')).not.toContain('{"  x2"}');
			// A mixin of that file called in the slots of the component for a pre.
			expect(component(extending, 'CExtendsPre')).toContain('<XmPre {...props} />');
			expect(component(extending, 'XmPre')).toContain('{"  m2"}');
			expect(component(extending, 'CExtends')).toContain('<Xm {...props} />');
			// What no pre calls has no component for it.
			expect(both).not.toContain('function TagPre(');
		});

		test('writes a > of the text as an entity', () => {
			expect(read('__assets/htdocs/index.tsx')).toContain('tbody &gt; tr');
		});

		test('types the functions and the constants of the Pug code, and not a string', () => {
			const page = read('__assets/htdocs/index.tsx');
			expect(page).toContain('const sources: Record<string, any> = { a: 1 }');
			expect(page).toContain('items.map((x: any) => x)');
			expect(page).toContain('{"x => y"}');
		});

		test('leaves out the key of an each that the body does not read, and marks an unused value', () => {
			const page = read('__assets/htdocs/index.tsx');
			expect(page).toContain('_eachOf(items).map(([item]: any) => (');
			expect(page).not.toContain('index: any');
			expect(page).toContain('_eachOf(items).map(([_item]: any) => (');
		});

		test('loops over an object by its keys and over an array by its indexes, as Pug does', () => {
			const page = read('__assets/htdocs/index.tsx');
			expect(page).toContain('_eachOf({ a: "item", b: "label" }).map(([v, k]: any) => (');
			expect(page).toContain('_eachOf(["x", "y"]).map(([v, i]: any) => (');
			// The `else` shows when there is nothing to loop over, for an object too, and what
			// is looped over is read once.
			expect(page).toContain('const _entries = _eachOf(sources);');
			expect(page).toContain('return _entries.length ? _entries.map(([v]: any) => (');
			// The helper is written once for the file, and the output needs nothing of kamado for it.
			expect(page.match(/function _eachOf\(/g)).toHaveLength(1);
		});

		test('writes the helper of each once in a file of mixins that loop in more than one', () => {
			const mixins = read('__assets/_libs/mixin/r.tsx');
			expect(mixins.match(/function _eachOf\(/g)).toHaveLength(1);
			expect(mixins).toContain('_eachOf(items).map(([v]: any) => (');
			expect(mixins).toContain('_eachOf(rows).map(([v, k]: any) => (');
		});

		test('does not write the helper of each in a file that has no each', () => {
			expect(read('__assets/_libs/mixin/m.tsx')).not.toContain('_eachOf');
		});

		test('gives the pairs of what each loops over in the order and the form Pug has', () => {
			const page = read('__assets/htdocs/index.tsx');
			const source = /function _eachOf[\s\S]*?\n\}\n/.exec(page)?.[0] ?? '';
			// The cut ends with the function, not before it.
			expect(source).toContain('return entries;\n}\n');
			const eachOf = new Function(
				`${ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}\nreturn _eachOf;`,
			)() as (value: unknown) => unknown[];
			expect(eachOf(['x', 'y'])).toEqual([
				['x', 0],
				['y', 1],
			]);
			expect(eachOf({ a: 'item', b: 'label' })).toEqual([
				['item', 'a'],
				['label', 'b'],
			]);
			expect(eachOf('ab')).toEqual([
				['a', 0],
				['b', 1],
			]);
			// By index up to `length`, as Pug does, not by the code points of an iterator.
			expect(eachOf('\u{1F600}a')).toEqual([
				['\uD83D', 0],
				['\uDE00', 1],
				['a', 2],
			]);
			expect(eachOf([])).toEqual([]);
			expect(eachOf({})).toEqual([]);
		});

		test('imports only the mixins that the page calls', () => {
			const page = read('__assets/htdocs/index.tsx');
			expect(page).toContain("import { A, Card } from '../_libs/mixin/m.tsx';");
			expect(page).not.toMatch(/import \{[^}]*\bB\b/);
		});

		test('does not pass a local that the object of a mixin call sets itself', () => {
			const call = read('__assets/htdocs/index.tsx')
				.split('\n')
				.find((line) => line.includes('<Card '));
			expect(call).toContain('{...({ lang })}');
			expect(call).not.toContain('lang={lang}');
		});

		test('writes a mixin argument that the body assigns to with let, and the others with const', () => {
			const mixins = read('__assets/_libs/mixin/r.tsx');
			expect(mixins).toContain('let { options, size = 1 } = props as any;');
			expect(mixins).toContain('let { label = "a" } = props as any;');
			// An assignment inside an `if`, and a destructuring one, count as well.
			expect(mixins).toContain('let { a, b } = props as any;');
			expect(mixins).toContain('let { label } = props as any;');
			expect(mixins).toContain('const { label } = props as any;');
			expect(mixins).not.toContain('const { options');
		});

		test('declares with let only the mixin arguments that the body assigns to', () => {
			const mixins = read('__assets/_libs/mixin/r.tsx');
			expect(mixins).toContain(
				'\tconst { a, b = 2 } = props as any;\n\tlet { options } = props as any;\n',
			);
			// A default reads the names before it: the declarations keep the order of the arguments.
			expect(mixins).toContain(
				'\tlet { a } = props as any;\n\tconst { b = a, c } = props as any;\n',
			);
		});

		test('declares with let only the names of an object pattern that the body assigns to', () => {
			const mixins = read('__assets/_libs/mixin/r.tsx');
			expect(mixins).toContain(
				'\tlet { label = "a" } = props as any;\n\tconst { size } = props as any;\n',
			);
			// A nested pattern is cut down to the name, and the order of the arguments stays
			// (the neighbours of the same keyword share a declaration).
			expect(mixins).toContain(
				'\tconst { first } = props as any;\n\tlet { head: { title } } = props as any;\n\tconst { head: { sub = 1 }, tail, last = first } = props as any;\n',
			);
			// A rest takes what the others leave: the pattern stays whole, and a name that
			// needs the other keyword is renamed there and declared after it.
			expect(mixins).toContain(
				'\tconst { id: _id, ...rest } = props as any;\n\tlet id = _id;\n',
			);
			expect(mixins).toContain(
				'\tconst { a, b = 1, ..._others } = props as any;\n\tlet others = _others;\n',
			);
			// A default that reads a renamed name reads the new name: the body has not run yet.
			expect(mixins).toContain(
				'\tconst { a: _a, b = _a, ...others } = props as any;\n\tlet a = _a;\n',
			);
			// The new name is not one that the pattern has already.
			expect(mixins).toContain(
				'\tconst { id: _id_, _id, ...others } = props as any;\n\tlet id = _id_;\n',
			);
			// A shorthand property in a default is renamed with its key kept.
			expect(mixins).toContain(
				'\tconst { a: _a, b = { a: _a }, ...r } = props as any;\n\tlet a = _a;\n',
			);
			expect(mixins).toContain(
				'\tconst { a: _a, b = () => _a, ...r } = props as any;\n\tlet a = _a;\n',
			);
			// A function in a default may declare the name again, with a block or a parameter:
			// nothing is renamed then.
			expect(mixins).toContain(
				'\tlet { a, b = () => { const a = 1; return a }, ...r } = props as any;\n',
			);
			expect(mixins).toContain('\tlet { a, b = (a = 0) => a, ...r } = props as any;\n');
			// A computed key is one piece, as it would run again for each piece.
			expect(mixins).toContain(
				'\tconst { ["x"]: { a: _a, b } } = props as any;\n\tlet a = _a;\n',
			);
			// Nested, with a rest, or with a default: the same.
			expect(mixins).toContain(
				'\tconst { head: { title: _title, sub }, ...others } = props as any;\n\tlet title = _title;\n',
			);
			expect(mixins).toContain(
				'\tconst { head: { title: _title, sub } = {} } = props as any;\n\tlet title = _title;\n\tconst { tail } = props as any;\n',
			);
		});

		test('declares the variables that the page gets from its props with const unless it assigns to them', () => {
			const page = read('__assets/htdocs/index.tsx');
			expect(page).toMatch(/\n\tconst \{ [^}]*\bitems\b[^}]* \} = _vars;\n/);
			expect(page).not.toContain('let {');
		});

		test('does not cast the variables of the props, which are an any already', () => {
			const page = read('__assets/htdocs/index.tsx');
			expect(page).toContain('const _vars = { ...(props as any).meta, ...props };');
		});

		test('writes a condition that is a boolean with no double negation, and any other with one', () => {
			const page = read('__assets/htdocs/index.tsx');
			expect(page).toContain('{!off && (');
			expect(page).toContain('{(lang === "en" || lang === "ja") && (');
			expect(page).toContain('{!!(items) && (');
			expect(page).not.toContain('!!(!');
		});

		test('puts the type of the props after the imports, which go in the order of import-x/order', () => {
			const page = read('__assets/htdocs/index.tsx');
			const head = page.slice(0, page.indexOf('\n\n', page.indexOf('type PageProps')));
			expect(head).toBe(
				[
					"import { html } from 'kamado/jsx';",
					'',
					"import CStatic from '../_libs/component/c-static.tsx';",
					"import { A, Card } from '../_libs/mixin/m.tsx';",
					'',
					'type PageProps = Record<string, any>;',
				].join('\n'),
			);
		});

		test('writes a constant at the top of a file of mixins at the top of the module', () => {
			const mixins = read('__assets/_libs/mixin/k.tsx');
			expect(mixins).toMatch(/\nconst X\b[^\n]*= \{ a: "item", b: "label" \};?\n/);
			expect(mixins.indexOf('const X')).toBeLessThan(
				mixins.indexOf('export function Lookup'),
			);
			// The mixin reads it as it is, and does not ask the props for it.
			expect(mixins).not.toContain('{ X }');
			// A constant that reads another, and a function, are written as well.
			expect(mixins).toMatch(/\nconst PAIR\b[^\n]*= \[X\.a, X\.b\];?\n/);
			expect(mixins).toContain('function pick(');
		});

		test('leaves out a constant at the top of a file of mixins that no mixin reads', () => {
			expect(read('__assets/_libs/mixin/k.tsx')).not.toContain('UNUSED');
		});

		test('warns of the top code of a file of mixins that reads what only a page gives', () => {
			expect(stdout).toContain(
				'warning: __assets/_libs/mixin/k.pug: the code at the top of a file of mixins reads fromPage, which only a page gives: it is not written; write it by hand',
			);
			// `block` and `locals` are reads of the props, which a module has none of.
			expect(stdout).toContain(
				'warning: __assets/_libs/mixin/k.pug: the code at the top of a file of mixins reads props, which only a page gives: it is not written; write it by hand',
			);
		});

		test('names the parameter that a component does not read with an underscore', () => {
			expect(read('__assets/_libs/component/c-static.tsx')).toContain(
				'function CStatic(_props: ',
			);
			const mixins = read('__assets/_libs/mixin/m.tsx');
			expect(mixins).toContain('function A(_props: ');
			expect(mixins).toContain('function Card(props: ');
		});

		test('writes the declarations of what the types of React lack', () => {
			const declarations = read('__assets/kamado-jsx.d.ts');
			expect(declarations).toContain('commandfor?: string | undefined;');
			expect(declarations).toContain('static?: boolean | undefined;');
		});

		test('passes the type check of the strictest configuration', () => {
			writeFileSync(
				path.join(out, 'tsconfig.json'),
				JSON.stringify({
					extends: path.join(
						repo,
						'node_modules',
						'@d-zero',
						'tsconfig',
						'tsconfig.json',
					),
					compilerOptions: {
						noEmit: true,
						jsx: 'preserve',
						allowImportingTsExtensions: true,
						typeRoots: [path.join(repo, 'node_modules', '@types')],
						types: ['react'],
						paths: {
							react: [path.join(repo, 'node_modules', '@types', 'react')],
							'kamado/jsx': [path.join(dist, 'runtime.d.ts')],
						},
					},
					include: ['__assets/**/*.tsx', '__assets/**/*.d.ts'],
				}),
			);
			let output = '';
			try {
				execFileSync(
					process.execPath,
					[path.join(repo, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', out],
					{ encoding: 'utf8', stdio: 'pipe' },
				);
			} catch (error) {
				output = String((error as { stdout?: string }).stdout);
			}
			expect(output).toBe('');
		}, 120_000);

		test('fails the run when the component for a pre would take the name of a mixin', () => {
			const project = path.join(root, 'pre-collision');
			const files: Record<string, string> = {
				'__assets/htdocs/index.pug': 'include /mixin/q.pug\n+box\n',
				'__assets/_libs/mixin/q.pug': `mixin foo
	| a
mixin foo-pre
	| b
mixin box
	pre
		+foo
`,
				'package.json': '{}',
			};
			for (const [file, text] of Object.entries(files)) {
				mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
				writeFileSync(path.join(project, file), text);
			}
			symlinkSync(path.join(repo, 'node_modules'), path.join(project, 'node_modules'));
			let status = 0;
			let stdout = '';
			try {
				execFileSync(
					process.execPath,
					[
						path.join(repo, 'scripts', 'pug-to-tsx.mjs'),
						project,
						path.join(root, 'pre-collision-out'),
					],
					{ encoding: 'utf8', stdio: 'pipe' },
				);
			} catch (error) {
				status = (error as { status: number }).status;
				stdout = String((error as { stdout?: string }).stdout);
			}
			expect(status).toBe(1);
			expect(stdout).toContain(
				'not converted: __assets/_libs/mixin/q.pug: the mixin foo is called in a pre, and FooPre is a mixin of the file already: write it by hand',
			);
		}, 60_000);

		test('fails the run when the component of an extending file for a pre would take the name of a mixin', () => {
			const project = path.join(root, 'pre-extends-collision');
			const files: Record<string, string> = {
				'__assets/htdocs/index.pug':
					'html\n\tbody\n\t\tpre\n\t\t\tinclude /component/thing.pug\n',
				'__assets/_libs/layout/base.pug': 'block content\n',
				'__assets/_libs/component/thing.pug': `extends /layout/base.pug
mixin thing-pre
	| a
block content
	| b
`,
				'package.json': '{}',
			};
			for (const [file, text] of Object.entries(files)) {
				mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
				writeFileSync(path.join(project, file), text);
			}
			symlinkSync(path.join(repo, 'node_modules'), path.join(project, 'node_modules'));
			let status = 0;
			let stdout = '';
			try {
				execFileSync(
					process.execPath,
					[
						path.join(repo, 'scripts', 'pug-to-tsx.mjs'),
						project,
						path.join(root, 'pre-extends-collision-out'),
					],
					{ encoding: 'utf8', stdio: 'pipe' },
				);
			} catch (error) {
				status = (error as { status: number }).status;
				stdout = String((error as { stdout?: string }).stdout);
			}
			expect(status).toBe(1);
			expect(stdout).toContain(
				'not converted: __assets/_libs/component/thing.pug: the file is included in a pre, and ThingPre is a mixin of the file already: write it by hand',
			);
		}, 60_000);

		test('stops with a reason on the acorn 7 that Pug pulls in', () => {
			const project = path.join(root, 'old-acorn');
			mkdirSync(path.join(project, 'node_modules'), { recursive: true });
			writeFileSync(path.join(project, 'package.json'), '{}');
			symlinkSync(
				path.join(repo, 'node_modules', 'is-expression', 'node_modules', 'acorn'),
				path.join(project, 'node_modules', 'acorn'),
			);
			let stderr = '';
			try {
				execFileSync(
					process.execPath,
					[
						path.join(repo, 'scripts', 'pug-to-tsx.mjs'),
						project,
						path.join(root, 'old-out'),
					],
					{ encoding: 'utf8', stdio: 'pipe' },
				);
			} catch (error) {
				stderr = String((error as { stderr?: string }).stderr);
			}
			expect(stderr).toBe(
				`acorn 7.4.1 is too old: the converter needs acorn 8 or later in ${project} (add it to its devDependencies)\n`,
			);
		});
	},
);
