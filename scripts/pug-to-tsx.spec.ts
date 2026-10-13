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
		each item, index in items
			span= item
		each item in items
			span x
		- const sources = { a: 1 }
		p= sources.a
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
	'__assets/_libs/mixin/r.pug': `mixin reassign(options, size = 1)
	- options = options || {}
	- size += 1
	p= options.label
	p= size
mixin reassignPattern({ label = "a" } = {})
	- label = label + "b"
	p= label
mixin guard(label)
	- if (!label) label = "x"
	p= label
mixin swap(a, b)
	- [a, b] = [b, a]
	p= a
mixin keep(label)
	p= label
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
			expect(page).toContain('items.map((item: any) => (');
			expect(page).not.toContain('index: any');
			expect(page).toContain('items.map((_item: any) => (');
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
