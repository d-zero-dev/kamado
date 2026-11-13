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
	existsSync(path.join(dist, 'index.d.ts'));

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
			// oxlint-disable-next-line typescript/no-implied-eval -- the transpiled helper that the generated page contains is evaluated to run it
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

		test('imports PageProps from kamado/jsx with the other imports in import-x/order', () => {
			const page = read('__assets/htdocs/index.tsx');
			const htmlImport = page.indexOf("import { html } from 'kamado/jsx';");
			const typeImport = page.indexOf("import type { PageProps } from 'kamado/jsx';");
			const relative = page.indexOf(
				"import CStatic from '../_libs/component/c-static.tsx';",
			);
			expect(htmlImport).toBeGreaterThanOrEqual(0);
			expect(typeImport).toBeGreaterThan(htmlImport);
			expect(relative).toBeGreaterThan(typeImport);
			expect(page.slice(htmlImport, relative).trimEnd()).toBe(
				[
					"import { html } from 'kamado/jsx';",
					"import type { PageProps } from 'kamado/jsx';",
				].join('\n'),
			);
			expect(page).toMatch(/props: PageProps & Record<string, any>/);
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
			expect(declarations).not.toContain('static?: boolean | undefined;');
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
							'kamado/jsx': [path.join(dist, 'index.d.ts')],
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

		// A project of its own, converted as a real one is: the files, the output and what
		// the converter said.
		const convertProject = (
			name: string,
			files: Record<string, string>,
			flags: string[] = [],
		) => {
			const project = path.join(root, name);
			const output = path.join(root, `${name}-out`);
			for (const [file, text] of Object.entries({
				'package.json': '{ "name": "fixture", "private": true }\n',
				...files,
			})) {
				mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
				writeFileSync(path.join(project, file), text);
			}
			symlinkSync(path.join(repo, 'node_modules'), path.join(project, 'node_modules'));
			const said = execFileSync(
				process.execPath,
				[path.join(repo, 'scripts', 'pug-to-tsx.mjs'), project, output, ...flags],
				{ encoding: 'utf8', stdio: 'pipe' },
			);
			return { project, output, said };
		};

		// What the type check of the strictest configuration says of an output ('' when it
		// passes).
		const typeErrorsOf = (output: string) => {
			writeFileSync(
				path.join(output, 'tsconfig.json'),
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
							'kamado/jsx': [path.join(dist, 'index.d.ts')],
						},
					},
					include: ['__assets/**/*.tsx', '__assets/**/*.d.ts'],
				}),
			);
			try {
				execFileSync(
					process.execPath,
					[path.join(repo, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', output],
					{ encoding: 'utf8', stdio: 'pipe' },
				);
			} catch (error) {
				return String((error as { stdout?: string }).stdout);
			}
			return '';
		};

		test('keeps the selected of an option, which a page written in order shows where it was written', () => {
			const { output } = convertProject('selected', {
				'__assets/htdocs/index.pug': `- var cond = true
html
	body
		select
			option(selected disabled value="/2026/") y
			option(selected=cond value="a") a
			option(value="b") b
`,
			});
			const page = readFileSync(path.join(output, '__assets/htdocs/index.tsx'), 'utf8');
			expect(page).toContain('<option selected disabled value="/2026/">');
			expect(page).toContain('<option selected={cond} value="a">');
			expect(page).not.toContain('defaultValue');
		});

		test('writes a checked that has no value as a bare attribute, as it does a selected (an empty string is not checked)', () => {
			const { output } = convertProject('checked', {
				'__assets/htdocs/index.pug': `html
	body
		input(type="checkbox" checked)
		input(type="checkbox" checked=cond)
		div(checked)
		div(selected)
`,
			});
			const page = readFileSync(path.join(output, '__assets/htdocs/index.tsx'), 'utf8');
			expect(page).toContain('<input type="checkbox" checked />');
			expect(page).toContain('<input type="checkbox" checked={cond} />');
			expect(page).not.toContain('<input type="checkbox" checked="" />');
			// React writes them in the code of `input` and `option` only: any other element drops them.
			expect(page).toContain('<div checked=""></div>');
			expect(page).toContain('<div selected=""></div>');
		});

		test('types what it writes for a boolean attribute that Pug writes as its own name, in the strictest configuration', () => {
			const { output } = convertProject('typed-booleans', {
				'__assets/htdocs/index.pug': `html
	body
		button(disabled="disabled") b
		input(type="text" required="required")
		a(href="/a" download="download") a
		select
			option(selected disabled value="/2026/") y
			option(selected="selected" value="a") a
			option(selected=cond value="b") b
		input(type="checkbox" checked)
		input(type="checkbox" checked="checked")
		input(type="checkbox" checked=cond)
`,
			});
			writeFileSync(
				path.join(output, 'tsconfig.json'),
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
							'kamado/jsx': [path.join(dist, 'index.d.ts')],
						},
					},
					include: ['__assets/**/*.tsx', '__assets/**/*.d.ts'],
				}),
			);
			let said = '';
			try {
				execFileSync(
					process.execPath,
					[path.join(repo, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', output],
					{ encoding: 'utf8', stdio: 'pipe' },
				);
			} catch (error) {
				said = String((error as { stdout?: string }).stdout);
			}
			expect(said).toBe('');
			const page = readFileSync(path.join(output, '__assets/htdocs/index.tsx'), 'utf8');
			expect(page).toContain('<option selected value="a">');
			expect(page).toContain('<input type="checkbox" checked />');
			expect(page).toContain('<button disabled>');
			expect(page).toContain('<input type="text" required />');
			// `download` takes a string in the types: it stays as it was written.
			expect(page).toContain('download="download"');
		}, 120_000);

		describe('a mixin defined inside a tag, a block or another mixin', () => {
			const files: Record<string, string> = {
				// In a file of mixins, inside the tag of a mixin: it reads a constant of that mixin.
				'__assets/_libs/component/c-head.pug': `mixin c-head(isH1 = false)
	- const label = "site"
	header.c-head
		mixin c-head__logo(isHeading)
			#{isHeading ? "h1" : "div"}.c-head__logo= label
		+c-head__logo(isH1)
		nav
			+c-head__logo(false)
`,
				'__assets/_libs/layouts/base.pug': 'html\n\tbody\n\t\tblock content\n',
				// In a block of a page that extends a layout: it reads a variable of the block.
				'__assets/htdocs/counter.pug': `extends /layouts/base.pug
block content
	- var names = { a: "A", b: "B" }
	mixin card(id)
		p.card= names[id]
	+card("a")
	+card("b")
`,
				// In the body of a page that extends nothing.
				'__assets/htdocs/index.pug': `include /component/c-head.pug
html
	body
		+c-head(true)
		mixin item(text)
			li= text
		ul
			+item("x")
			+item("y")
`,
			};
			let output: string;
			let said: string;
			const page = (file: string) => readFileSync(path.join(output, file), 'utf8');

			beforeAll(() => {
				({ output, said } = convertProject('nested-mixins', files));
			}, 60_000);

			test('converts the files instead of stopping on them', () => {
				expect(said).not.toContain('not converted');
				expect(said).toContain('4 files converted');
			});

			test('writes the mixin as a component of the module that the calls render', () => {
				const head = page('__assets/_libs/component/c-head.tsx');
				expect(head).toContain('function CHeadLogo(props: ');
				// Only the mixin of the file is exported: the inner one is its own.
				expect(head).not.toContain('export function CHeadLogo');
				expect(head).toContain('export function CHead(props: ');
				expect(head).toMatch(/<CHeadLogo \{\.\.\.props\}[^\n]* isHeading=\{isH1\} \/>/);
				expect(head).toMatch(/<CHeadLogo \{\.\.\.props\}[^\n]* isHeading=\{false\} \/>/);
				// What it reads of the mixin around it comes with the call.
				expect(head).toMatch(/<CHeadLogo \{\.\.\.props\} [^\n]*label=\{label\}/);
				const counter = page('__assets/htdocs/counter.tsx');
				expect(counter).toContain('function Card(props: ');
				expect(counter).toMatch(
					/<Card \{\.\.\.props\} [^\n]*names=\{names\}[^\n]* id=\{"a"\} \/>/,
				);
				const index = page('__assets/htdocs/index.tsx');
				expect(index).toContain('function Item(props: ');
				expect(index).toMatch(/<Item \{\.\.\.props\}[^\n]* text=\{"x"\} \/>/);
			});

			test('writes nothing where the mixin is defined', () => {
				const index = page('__assets/htdocs/index.tsx');
				expect(index).not.toContain('mixin');
				// The body has the two calls and nothing else of the mixin.
				expect(index.match(/<Item\b/g)).toHaveLength(2);
				const body = index.slice(index.indexOf('export default function Index'));
				expect(body).not.toMatch(/function Item|\{\}|<li>/);
			});

			test('passes the type check of the strictest configuration', () => {
				expect(typeErrorsOf(output)).toBe('');
			}, 120_000);
		});

		test('leaves out a declaration that nothing reads, and warns of one whose code may do something', () => {
			const { output, said } = convertProject('unused-declarations', {
				'__assets/htdocs/index.pug': `- const unused = site.host + page.url
- const used = "a"
- const onlyByUnused = 1
- const alsoUnused = onlyByUnused + 1
- function helper() { return 1 }
- const tracked = track()
- const url = site.host + page.url
- const id = page.slug
- const t = title
html
	head
		meta(property="og:url" content=site.host + page.url)
		meta(name="title")
	body
		p= used
		a(href="?id=" + id + "&x=1") a
`,
			});
			const page = readFileSync(path.join(output, '__assets/htdocs/index.tsx'), 'utf8');
			expect(page).toContain('const used = "a"');
			expect(page).not.toContain('unused');
			expect(page).not.toContain('onlyByUnused');
			expect(page).not.toContain('alsoUnused');
			expect(page).not.toContain('helper');
			// The name in the value of an attribute is not a read of it.
			expect(page).not.toContain('const url');
			// A read between two strings is a read.
			expect(page).toContain('const id = page.slug');
			// What only a declaration left out read is not taken from the props.
			expect(page).not.toContain('const t ');
			expect(page).not.toMatch(/\{[^}]*\btitle\b[^}]*\} = /);
			// A call may do something: the declaration stays, and the run says so.
			expect(page).toContain('const tracked = track()');
			expect(said).toContain(
				'warning: __assets/htdocs/index.pug: nothing reads tracked, and its code may do something, so it is written: write it by hand',
			);
		});

		describe('a file that is not Pug, included by a template', () => {
			const files: Record<string, string> = {
				'__assets/_libs/component/frag.html': '<div class="frag">a</div>\n',
				'__assets/_libs/data/note.html': '<p>note</p>\n',
				'__assets/outside.html': '<p>outside</p>\n',
				'__assets/htdocs/index.pug': `html
	body
		include /component/frag.html
		include ../_libs/component/frag.html
		include /data/note.html
		include ../outside.html
`,
			};
			const convertWith = (name: string, flags: string[]) => {
				const { output, said } = convertProject(name, files, flags);
				const page = readFileSync(path.join(output, '__assets/htdocs/index.tsx'), 'utf8');
				return { said, page };
			};

			test('copies the text in and says that a later edit of the file does not reach the output', () => {
				const { said, page } = convertWith('raw-copied', []);
				expect(page).toContain(
					`{html(${JSON.stringify('<div class="frag">a</div>\n')})}`,
				);
				expect(page).toContain(`{html(${JSON.stringify('<p>outside</p>\n')})}`);
				expect(said).toContain(
					'warning: __assets/htdocs/index.pug: the text of __assets/_libs/component/frag.html is copied in, and a later edit of it does not reach the output (--include-comment=<root> writes an @include of the includeComment preset instead)',
				);
				expect(said).toContain(
					'warning: __assets/htdocs/index.pug: the text of __assets/outside.html is copied in, and a later edit of it does not reach the output (--include-comment=<root> writes an @include of the includeComment preset instead)',
				);
				// One of the data directory is a value of the data, which a build reads each time.
				expect(page).toContain('{html((props.data as any)["note"])}');
				expect(said).not.toContain('data/note.html is copied');
			});

			test('writes an @include of the includeComment preset for a file under the root that the option names', () => {
				const { said, page } = convertWith('raw-comment', [
					'--include-comment=__assets/_libs',
				]);
				// The path is from the root, as the preset reads a path that starts with `/`.
				expect(
					page.match(/\{html\("<!-- @include\(\/component\/frag\.html\) -->"\)\}/g),
				).toHaveLength(2);
				expect(page).not.toContain('class=\\"frag\\"');
				expect(said).not.toContain('frag.html is copied');
				// A file outside of the root is copied in, with a warning.
				expect(page).toContain(`{html(${JSON.stringify('<p>outside</p>\n')})}`);
				expect(said).toContain(
					'warning: __assets/htdocs/index.pug: the text of __assets/outside.html is copied in, and a later edit of it does not reach the output (it is not under the root of --include-comment)',
				);
				expect(page).toContain('{html((props.data as any)["note"])}');
			});

			test('writes the @include when the project is named by a relative path', () => {
				convertProject('raw-relative', files);
				const said = execFileSync(
					process.execPath,
					[
						path.join(repo, 'scripts', 'pug-to-tsx.mjs'),
						'raw-relative',
						'raw-relative-from-cwd',
						'--include-comment=__assets/_libs',
					],
					{ cwd: root, encoding: 'utf8', stdio: 'pipe' },
				);
				const page = readFileSync(
					path.join(root, 'raw-relative-from-cwd', '__assets/htdocs/index.tsx'),
					'utf8',
				);
				expect(
					page.match(/\{html\("<!-- @include\(\/component\/frag\.html\) -->"\)\}/g),
				).toHaveLength(2);
				expect(said).not.toContain('frag.html is copied');
			});
		});

		// A run of the converter that is expected to fail: its exit status and what it said.
		const failedRun = (
			name: string,
			files: Record<string, string>,
			flags: string[] = [],
		) => {
			try {
				convertProject(name, files, flags);
			} catch (error) {
				const { status, stdout, stderr } = error as {
					status: number;
					stdout?: string;
					stderr?: string;
				};
				return { status, said: `${stdout ?? ''}${stderr ?? ''}` };
			}
			return { status: 0, said: '' };
		};

		test('fails the run when a mixin defined inside a tag writes a variable of the scope around it', () => {
			const { status, said } = failedRun('nested-mixin-write', {
				'__assets/htdocs/index.pug': `- var n = 0
html
	body
		mixin item
			- n++
			li= n
		ul
			+item
			+item
`,
			});
			expect(status).toBe(1);
			expect(said).toContain(
				'not converted: __assets/htdocs/index.pug: the mixin item assigns to n, which it does not declare (Pug writes it outside of the mixin): write it by hand',
			);
		}, 60_000);

		test('fails the run when a mixin defined inside a tag assigns a name that nothing declares', () => {
			const { status, said } = failedRun('nested-mixin-undeclared', {
				'__assets/htdocs/index.pug': `html
	body
		mixin item
			- fresh = 1
			li= fresh
		ul
			+item
`,
			});
			expect(status).toBe(1);
			expect(said).toContain(
				'not converted: __assets/htdocs/index.pug: the mixin item assigns to fresh, which it does not declare (Pug writes it outside of the mixin): write it by hand',
			);
		}, 60_000);

		test('converts a mixin defined inside a tag that assigns the variable of its own loop', () => {
			const { output, said } = convertProject('nested-mixin-own-loop', {
				'__assets/htdocs/index.pug': `html
	body
		mixin item(list)
			each v in list
				- v = v + 1
				li= v
		ul
			+item([1, 2])
`,
			});
			expect(said).not.toContain('not converted');
			expect(
				readFileSync(path.join(output, '__assets/htdocs/index.tsx'), 'utf8'),
			).toContain('function Item(');
		}, 60_000);

		test('fails the run when a loop around the call of a mixin defined inside a tag hides a name it reads', () => {
			const { status, said } = failedRun('nested-mixin-hidden', {
				'__assets/htdocs/index.pug': `- var item = "outer"
html
	body
		mixin show
			p= item
		each item in ["a", "b"]
			+show
`,
			});
			expect(status).toBe(1);
			expect(said).toContain(
				'not converted: __assets/htdocs/index.pug: the mixin show reads item, which a loop around a call of it declares too (Pug reads the one where the mixin is defined): write it by hand',
			);
		}, 60_000);

		test('fails the run when a mixin defined inside a tag takes the name of a component of the file', () => {
			const { status, said } = failedRun('nested-mixin-page-name', {
				'__assets/htdocs/index.pug': `html
	body
		mixin index
			p x
		+index
`,
			});
			expect(status).toBe(1);
			expect(said).toContain(
				'not converted: __assets/htdocs/index.pug: the mixin index takes the name of a component of the file (Index): write it by hand',
			);
		}, 60_000);

		test('fails the run when a mixin defined inside a tag takes the name of a mixin of a file it includes', () => {
			const { status, said } = failedRun('nested-mixin-imported-twin', {
				'__assets/_libs/component/c-head.pug': 'mixin c-head\n\tp head\n',
				'__assets/htdocs/index.pug': `include /component/c-head.pug
html
	body
		mixin c-head
			p own
		+c-head
`,
			});
			expect(status).toBe(1);
			expect(said).toContain(
				'not converted: __assets/htdocs/index.pug: the mixin c-head is defined in the file, and a file it includes has one of the same name: write it by hand',
			);
		}, 60_000);

		test('leaves out a mixin defined inside a tag that nothing calls, and passes the type check', () => {
			const { output } = convertProject('nested-mixin-uncalled', {
				'__assets/_libs/component/c-sample.pug': 'mixin c-sample\n\tspan s\n',
				'__assets/htdocs/index.pug': `include /component/c-sample.pug
html
	body
		mixin unused
			p never
		mixin wrap
			pre
				+c-sample
		+wrap
`,
			});
			const page = readFileSync(path.join(output, '__assets/htdocs/index.tsx'), 'utf8');
			expect(page).not.toContain('Unused');
			// A mixin of an included file called in a pre inside a mixin of the page.
			expect(page).toContain('function Wrap(');
			expect(page).toContain('<CSamplePre {...props}');
			expect(typeErrorsOf(output)).toBe('');
		}, 120_000);

		test('leaves out a mixin that nothing calls even when the text of the page has its name', () => {
			const { output } = convertProject('nested-mixin-name-in-text', {
				'__assets/htdocs/index.pug': `html
	body
		mixin card
			p c
		p Card
`,
			});
			const page = readFileSync(path.join(output, '__assets/htdocs/index.tsx'), 'utf8');
			expect(page).not.toContain('function Card(');
			expect(typeErrorsOf(output)).toBe('');
		}, 120_000);

		test('refuses a flag that takes a value written without "="', () => {
			const { status, said } = failedRun(
				'flag-without-equals',
				{ '__assets/htdocs/index.pug': 'html\n\tbody\n' },
				['--include-comment', '__assets/_libs'],
			);
			expect(status).toBe(1);
			expect(said).toContain(
				'--include-comment takes its value after "=" (--include-comment=<value>)',
			);
		}, 60_000);

		test('takes a root whose name starts with two dots inside of the project', () => {
			const { output, said } = convertProject(
				'include-comment-dots',
				{
					'__assets/..parts/frag.html': '<p>f</p>\n',
					'__assets/htdocs/index.pug': 'html\n\tbody\n\t\tinclude ../..parts/frag.html\n',
				},
				['--include-comment=__assets/..parts'],
			);
			expect(said).not.toContain('copied in');
			expect(
				readFileSync(path.join(output, '__assets/htdocs/index.tsx'), 'utf8'),
			).toContain('@include(/frag.html)');
		}, 60_000);

		test('converts a mixin defined in the branch of an else if', () => {
			const { output, said } = convertProject('nested-mixin-else-if', {
				'__assets/htdocs/index.pug': `- var a = false
- var b = true
html
	body
		if a
			p a
		else if b
			mixin foo
				p foo
			+foo
`,
			});
			expect(said).not.toContain('not converted');
			const page = readFileSync(path.join(output, '__assets/htdocs/index.tsx'), 'utf8');
			expect(page).toContain('function Foo(');
			expect(page).toContain('<Foo {...props}');
		}, 60_000);

		test.each([
			['include-comment-empty', '--include-comment='],
			['include-comment-missing', '--include-comment=__assets/nothing'],
			['include-comment-project', '--include-comment=.'],
			['include-comment-outside', '--include-comment=..'],
			['include-comment-absolute', '--include-comment=/'],
		])(
			'refuses an --include-comment that names no directory inside of the project (%s)',
			(name, flag) => {
				const { status, said } = failedRun(
					name,
					{ '__assets/htdocs/index.pug': 'html\n\tbody\n' },
					[flag],
				);
				expect(status).toBe(1);
				expect(said).toContain(
					`${flag}: name the directory that is the root of the includeComment preset, from the project (for example --include-comment=__assets/_libs)`,
				);
			},
			60_000,
		);

		test('fails the run when a mixin defined inside a tag takes the name of another mixin of the module', () => {
			const { status, said } = failedRun('nested-mixin-collision', {
				'__assets/htdocs/index.pug': `mixin item
	| a
html
	body
		mixin item
			| b
		+item
`,
			});
			expect(status).toBe(1);
			expect(said).toContain(
				'not converted: __assets/htdocs/index.pug: the mixin item is defined twice in the file: write it by hand',
			);
		}, 60_000);

		describe('a mixin defined inside a tag of a file of mixins or of a page that extends a layout', () => {
			const layout = {
				'__assets/_libs/layouts/base.pug': 'html\n\tbody\n\t\tblock content\n',
			};
			const page = (file: string) => ({
				'__assets/htdocs/index.pug': `include ${file}\nhtml\n\tbody\n\t\t+c-a\n`,
			});

			test.each([
				[
					'file of mixins: a write outside',
					{
						'__assets/_libs/component/c-a.pug': `mixin c-a
	- var n = 0
	div
		mixin inner
			- n++
			p= n
		+inner
`,
						...page('/component/c-a.pug'),
					},
					'__assets/_libs/component/c-a.pug: the mixin inner assigns to n, which it does not declare (Pug writes it outside of the mixin): write it by hand',
				],
				[
					'file of mixins: the name of an included mixin',
					{
						'__assets/_libs/component/c-b.pug': 'mixin c-b\n\tp b\n',
						'__assets/_libs/component/c-a.pug': `include /component/c-b.pug
mixin c-a
	div
		mixin c-b
			p own
		+c-b
`,
						...page('/component/c-a.pug'),
					},
					'__assets/_libs/component/c-a.pug: the mixin c-b is defined in the file, and a file it includes has one of the same name: write it by hand',
				],
				[
					'file of mixins: a name twice',
					{
						'__assets/_libs/component/c-a.pug': `mixin c-a
	div
		mixin item
			p inner
		+item
mixin item
	p top
`,
						...page('/component/c-a.pug'),
					},
					'__assets/_libs/component/c-a.pug: the mixin item is defined twice in the file: write it by hand',
				],
				[
					'page that extends a layout: a write outside',
					{
						...layout,
						'__assets/htdocs/index.pug': `extends /layouts/base.pug
block content
	- var n = 0
	mixin inner
		- n++
		p= n
	+inner
`,
					},
					'__assets/htdocs/index.pug: the mixin inner assigns to n, which it does not declare (Pug writes it outside of the mixin): write it by hand',
				],
				[
					'page that extends a layout: the name of an included mixin',
					{
						...layout,
						'__assets/_libs/component/c-b.pug': 'mixin c-b\n\tp b\n',
						'__assets/htdocs/index.pug': `extends /layouts/base.pug
block content
	include /component/c-b.pug
	mixin c-b
		p own
	+c-b
`,
					},
					'__assets/htdocs/index.pug: the mixin c-b is defined in the file, and a file it includes has one of the same name: write it by hand',
				],
			])(
				'fails the run (%s)',
				(name, files, message) => {
					const { status, said } = failedRun(
						`nested-mixin-stop-${name.replaceAll(/\W+/g, '-')}`,
						files,
					);
					expect(status).toBe(1);
					expect(said).toContain(`not converted: ${message}`);
				},
				60_000,
			);

			test('leaves out the mixins that nothing calls, also one that only another left out calls', () => {
				const { output } = convertProject('nested-mixin-uncalled-chain', {
					...layout,
					'__assets/_libs/component/c-a.pug': `mixin c-a
	div
		mixin x
			p x
		mixin y
			+x
		mixin z
			p z
		+z
`,
					'__assets/htdocs/index.pug': `extends /layouts/base.pug
block content
	include /component/c-a.pug
	mixin u
		p u
	mixin w
		+u
	+c-a
`,
				});
				const mixins = readFileSync(
					path.join(output, '__assets/_libs/component/c-a.tsx'),
					'utf8',
				);
				expect(mixins).toContain('function Z(');
				expect(mixins).not.toMatch(/function [XY]\(/);
				const index = readFileSync(
					path.join(output, '__assets/htdocs/index.tsx'),
					'utf8',
				);
				expect(index).not.toMatch(/function [UW]\(/);
				expect(typeErrorsOf(output)).toBe('');
			}, 120_000);

			test('writes a mixin defined inside a tag that a pre calls in a file of mixins, and in a file that a pre includes', () => {
				const { output, said } = convertProject('nested-mixin-pre', {
					'__assets/_libs/component/c-a.pug': `mixin c-a
	div
		mixin inner
			span i
		pre
			+inner
`,
					'__assets/_libs/component/c-text.pug': `div
	mixin t
		span t
	+t
`,
					'__assets/htdocs/index.pug': `include /component/c-a.pug
html
	body
		+c-a
		pre
			include /component/c-text.pug
`,
				});
				expect(said).not.toContain('not converted');
				const mixins = readFileSync(
					path.join(output, '__assets/_libs/component/c-a.tsx'),
					'utf8',
				);
				expect(mixins).toContain('<InnerPre {...props}');
				const text = readFileSync(
					path.join(output, '__assets/_libs/component/c-text.tsx'),
					'utf8',
				);
				expect(text).toContain('function TPre(');
				expect(text).toContain('<TPre {...props}');
				expect(typeErrorsOf(output)).toBe('');
			}, 120_000);
		});

		test('keeps and warns of a declaration whose code may do something, of each kind', () => {
			const { said } = convertProject('declarations-effects', {
				'__assets/htdocs/index.pug': `- const made = new Date()
- let c
- const set = (c = 1)
- const { d = f() } = page
- const gone = delete page.x
- const fn = () => track()
html
	body
		p= c
`,
			});
			for (const name of ['made', 'set', 'd', 'gone']) {
				expect(said).toContain(
					`warning: __assets/htdocs/index.pug: nothing reads ${name}, and its code may do something, so it is written: write it by hand`,
				);
			}
			// A function written in the code is not run where it is written: it can go.
			expect(said).not.toContain('nothing reads fn');
		}, 60_000);

		test('takes from the props of a mixin only what is still read when a declaration goes', () => {
			const { output } = convertProject('declarations-mixin-props', {
				'__assets/_libs/component/c-a.pug': `mixin c-a(label = "a")
	- const t = title
	p= label
`,
				'__assets/htdocs/index.pug':
					'include /component/c-a.pug\nhtml\n\tbody\n\t\t+c-a\n',
			});
			const mixins = readFileSync(
				path.join(output, '__assets/_libs/component/c-a.tsx'),
				'utf8',
			);
			expect(mixins).not.toContain('const t ');
			expect(mixins).not.toMatch(/\btitle\b/);
			expect(typeErrorsOf(output)).toBe('');
		}, 120_000);

		describe('the layout of a sidecar and of a front matter', () => {
			const layouts: Record<string, string> = {
				'__assets/_libs/layouts/price.pug': 'html\n\tbody\n\t\tblock content\n',
				'__assets/htdocs/price/index.pug':
					'extends /layouts/price.pug\nblock content\n\tp x\n',
				'__assets/htdocs/price/index.json':
					'{\n\t"title": "T",\n\t"layout": "price.pug"\n}\n',
				'__assets/htdocs/about.html':
					'---\ntitle: T\nlayout: "layouts/price.pug"\n---\n<p>layout: price.pug</p>\n',
				'__assets/htdocs/gone.html': '<p>x</p>\n',
				'__assets/htdocs/gone.json': '{ "layout": "gone.pug" }\n',
				'__assets/htdocs/plain.html': '<p>x</p>\n',
				'__assets/htdocs/plain.json': '{ "layout": "price" }\n',
				'__assets/_libs/data/frag.html': '<hr>\n',
			};

			test('writes a copy of the sidecar and of the page with the extension left out, and says which', () => {
				const { project, output, said } = convertProject('layout', layouts);
				const copy = (file: string) => readFileSync(path.join(output, file), 'utf8');
				expect(copy('__assets/htdocs/price/index.json')).toBe(
					'{\n\t"title": "T",\n\t"layout": "price"\n}\n',
				);
				expect(copy('__assets/htdocs/about.html')).toBe(
					'---\ntitle: T\nlayout: "layouts/price"\n---\n<p>layout: price.pug</p>\n',
				);
				expect(said).toContain('layout rewritten: __assets/htdocs/price/index.json');
				expect(said).toContain('layout rewritten: __assets/htdocs/about.html');
				expect(
					readFileSync(path.join(project, '__assets/htdocs/price/index.json'), 'utf8'),
				).toContain('price.pug');
			});

			test('warns of a layout that names no converted file, and still writes the name without the extension', () => {
				const { output, said } = convertProject('layout-gone', layouts);
				expect(said).toContain(
					'warning: __assets/htdocs/gone.json: layout "gone.pug" names no converted file',
				);
				expect(readFileSync(path.join(output, '__assets/htdocs/gone.json'), 'utf8')).toBe(
					'{ "layout": "gone" }\n',
				);
			});

			test('rewrites the layout of the top level, whatever comes before it, and a name with $ as it is', () => {
				const { output, said } = convertProject('layout-edge', {
					'__assets/htdocs/nested.html': '<p>x</p>\n',
					'__assets/htdocs/bad.html': '<p>x</p>\n',
					'__assets/htdocs/nested.json':
						'{ "blocks": { "layout": "price.pug" }, "layout": "price.pug" }\n',
					'__assets/htdocs/dollar.json': '{ "layout": "a$&b.pug" }\n',
					'__assets/htdocs/dollar.html': '---\nlayout: "a$&b.pug"\n---\n<p>x</p>\n',
					'__assets/htdocs/bad.json': '{ "layout": "price.pug", }\n',
				});
				const copy = (file: string) => readFileSync(path.join(output, file), 'utf8');
				expect(copy('__assets/htdocs/nested.json')).toBe(
					'{ "blocks": { "layout": "price.pug" }, "layout": "price" }\n',
				);
				expect(copy('__assets/htdocs/dollar.json')).toBe('{ "layout": "a$&b" }\n');
				expect(copy('__assets/htdocs/dollar.html')).toBe(
					'---\nlayout: "a$&b"\n---\n<p>x</p>\n',
				);
				expect(said).toContain(
					'warning: __assets/htdocs/bad.json: not valid JSON, the layout "price.pug" is not rewritten',
				);
				expect(existsSync(path.join(output, '__assets/htdocs/bad.json'))).toBe(false);
			});

			test('rewrites the layout of a front matter in each way it is written, and warns of one it does not read', () => {
				const page = (front: string) => `---\n${front}\n---\n<p>x</p>\n`;
				// A byte order mark, which a text editor of Windows may put first in a file.
				const bom = String.fromCodePoint(0xfe_ff);
				const { output, said } = convertProject('layout-forms', {
					'__assets/htdocs/bom.html': bom + page('layout: layouts/price.pug'),
					'__assets/_libs/layouts/price.pug': 'html\n\tbody\n\t\tblock content\n',
					'__assets/htdocs/unquoted.html': page('layout: layouts/price.pug'),
					'__assets/htdocs/single.html': page("layout: 'layouts/price.pug'"),
					'__assets/htdocs/comment.html': page('layout: "layouts/price.pug" # c'),
					'__assets/htdocs/crlf.html':
						'---\r\nlayout: layouts/price.pug\r\n---\r\n<p>x</p>\r\n',
					'__assets/htdocs/spaced.html': page('layout : layouts/price.pug'),
					'__assets/htdocs/slash.html': page('layout: /layouts/price.pug'),
					'__assets/htdocs/gone.html': page('layout: gone.pug'),
					'__assets/htdocs/unmatched.html': page('layout: "a#b.pug"'),
					'__assets/htdocs/body.html': '---\ntitle: T\n---\n<p>layout: price.pug</p>\n',
					'__assets/htdocs/dup.html': '<p>x</p>\n',
					'__assets/htdocs/escaped.html': '<p>x</p>\n',
					// The last of two keys is the one that JSON.parse reads.
					'__assets/htdocs/dup.json':
						'{"layout":"other.pug","x":1,"layout":"layouts/price.pug"}\n',
					'__assets/htdocs/escaped.json': '{ "layout": "layouts/price\\u002epug" }\n',
				});
				const copy = (file: string) => readFileSync(path.join(output, file), 'utf8');
				expect(copy('__assets/htdocs/unquoted.html')).toBe(page('layout: layouts/price'));
				expect(copy('__assets/htdocs/single.html')).toBe(page("layout: 'layouts/price'"));
				expect(copy('__assets/htdocs/comment.html')).toBe(
					page('layout: "layouts/price" # c'),
				);
				expect(copy('__assets/htdocs/crlf.html')).toBe(
					'---\r\nlayout: layouts/price\r\n---\r\n<p>x</p>\r\n',
				);
				expect(copy('__assets/htdocs/bom.html')).toBe(
					bom + page('layout: layouts/price'),
				);
				expect(copy('__assets/htdocs/spaced.html')).toBe(page('layout : layouts/price'));
				expect(copy('__assets/htdocs/slash.html')).toBe(page('layout: /layouts/price'));
				expect(copy('__assets/htdocs/gone.html')).toBe(page('layout: gone'));
				expect(copy('__assets/htdocs/dup.json')).toBe(
					'{"layout":"other.pug","x":1,"layout":"layouts/price"}\n',
				);
				for (const file of ['unmatched.html', 'body.html', 'escaped.json']) {
					expect(existsSync(path.join(output, '__assets/htdocs', file))).toBe(false);
				}
				// Exactly these: a name that a converted file ends with, with or without a leading
				// `/`, is not warned of.
				expect(said.split('\n').filter((line) => line.startsWith('warning:'))).toEqual([
					'warning: __assets/htdocs/escaped.json: the layout "layouts/price.pug" is not rewritten',
					'warning: __assets/htdocs/gone.html: layout "gone.pug" names no converted file',
					'warning: __assets/htdocs/unmatched.html: the layout of the front matter is not rewritten',
				]);
			});

			test('does not warn of a layout that a converted file is', () => {
				const { said } = convertProject('layout-clean', layouts);
				// Only `gone.json` of the fixture names a layout that no converted file is.
				expect(said.split('\n').filter((line) => line.startsWith('warning:'))).toEqual([
					'warning: __assets/htdocs/gone.json: layout "gone.pug" names no converted file',
				]);
			});

			test('reads a JSON only when a page of its name is next to it, whatever the page is written in', () => {
				const named = '{ "layout": "layouts/price.pug" }\n';
				const { output, said } = convertProject('layout-sidecars', {
					'__assets/_libs/layouts/price.pug': 'html\n\tbody\n\t\tblock content\n',
					'__assets/htdocs/home.pug':
						'extends /layouts/price.pug\nblock content\n\tp x\n',
					'__assets/htdocs/home.json': named,
					'__assets/htdocs/faq.html': '<p>x</p>\n',
					'__assets/htdocs/faq.json': named,
					'__assets/htdocs/about.tsx': 'export default () => null;\n',
					'__assets/htdocs/about.json': named,
					'__assets/htdocs/legacy.jsx': 'export default () => null;\n',
					'__assets/htdocs/legacy.json': named,
					// No page of the name: data, not the sidecar of a page.
					'__assets/htdocs/lone.json': named,
					'__assets/_libs/data/menu.json': '{ "layout": "gone.pug" }\n',
				});
				for (const file of ['home', 'faq', 'about', 'legacy']) {
					expect(
						readFileSync(path.join(output, `__assets/htdocs/${file}.json`), 'utf8'),
					).toBe('{ "layout": "layouts/price" }\n');
				}
				expect(existsSync(path.join(output, '__assets/htdocs/lone.json'))).toBe(false);
				expect(existsSync(path.join(output, '__assets/_libs/data/menu.json'))).toBe(
					false,
				);
				expect(said).not.toContain('lone.json');
				expect(said).not.toContain('menu.json');
			});

			test('does not write a file whose layout is not a pug', () => {
				const { output, said } = convertProject('layout-plain', layouts);
				expect(existsSync(path.join(output, '__assets/htdocs/plain.json'))).toBe(false);
				expect(existsSync(path.join(output, '__assets/_libs/data/frag.html'))).toBe(
					false,
				);
				expect(said).not.toContain('plain.json');
			});
		});
	},
);
