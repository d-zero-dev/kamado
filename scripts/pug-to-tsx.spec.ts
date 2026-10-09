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
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

// The converter is run on a small project, as it is run on a real one. It reads the Pug
// code with the packages of the project (`pug-lexer`, `pug-parser`, `acorn`) and the tables
// of a build of kamado, so the test is skipped where they are not there.
const repo = path.resolve(import.meta.dirname, '..');
const dist = path.join(repo, 'packages', 'kamado', 'dist', 'jsx');
const require = createRequire(import.meta.url);
const hasPug = (() => {
	try {
		for (const name of ['pug-lexer', 'pug-parser', 'acorn']) {
			require.resolve(name);
		}
		return true;
	} catch {
		return false;
	}
})();
const available =
	hasPug &&
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
	'__assets/_libs/data/frag.html': '<hr>\n',
	'package.json': '{ "name": "fixture", "private": true }\n',
};

describe.skipIf(!available)('pug-to-tsx.mjs on a small project', () => {
	let root: string;
	let out: string;
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
		execFileSync(
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
			'<button type="button" {...{ "onclick": "return false;" }} tabIndex={-1}>',
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
				extends: path.join(repo, 'node_modules', '@d-zero', 'tsconfig', 'tsconfig.json'),
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
});
