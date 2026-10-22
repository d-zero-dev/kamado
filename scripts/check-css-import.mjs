/**
 * Differential check of stylesheet bundling: the same fixture is built by v2's
 * style compiler pipeline (postcss + postcss-import + cssnano, configured as
 * `@kamado-io/style-compiler` does) and by the v3 CLI, and the outputs are
 * compared.
 *
 * Usage (needs `cargo build -p kd_napi` and `yarn build` first):
 *   node scripts/check-css-import.mjs
 *
 * The outputs must be identical, except where cssnano does something this
 * minifier deliberately does not (see the crate documentation of kd_css); those
 * are listed as "differs" with both sides, never hidden.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import cssnano from 'cssnano';
import postcss from 'postcss';
import postcssImport from 'postcss-import';

const repo = path.resolve(import.meta.dirname, '..');
const root = mkdtempSync(path.join(tmpdir(), 'kamado-css-import-'));

/** The fixture: file name → content. `main*.css` are the entries. */
const FILES = {
	'css/base/reset.css': 'html { margin : 0 }\nbody { margin : 0px }\n',
	'css/base/index.css': "@import './reset.css';\n.base { color : #FFFFFF }\n",
	'css/theme.css': '.theme { background : red ; color : rgba(0,0,0,.5) }\n',
	'css/print.css': '.print { display : none }\n',
	'css/main1.css':
		'@import \'base/index.css\';\n@import url("theme.css");\n.main { padding : 0px 0px 0px 0px }\n',
	'css/main2.css':
		"@import 'theme.css' screen and (min-width: 600px);\n@import 'print.css' print;\n@import 'base/reset.css';\n.m2 { margin : 10px }\n",
	'css/main3.css':
		"@charset \"utf-8\";\n@import 'theme.css';\n@import 'theme.css';\n.m3 { font-weight : normal }\n",
	'css/main4.css': "@import '@/theme.css';\n.m4 { top : 0px }\n",
	'css/main5.css': "@import 'base/index.css';\n@import 'base/reset.css';\n.m5{}\n",
	'node_modules/pkg/package.json': '{ "name": "pkg", "style": "dist/pkg.css" }',
	'node_modules/pkg/dist/pkg.css': '.pkg { color : blue }\n',
	'css/main6.css': "@import 'pkg';\n.m6 { color : red }\n",
	// A remote import inside an imported file keeps the conditions of the import
	// and stays behind the layer order.
	'css/remote.css': "@import 'https://example.com/font.css';\n.remote { color : blue }\n",
	'css/main7.css': "@layer x, y;\n@import 'remote.css' layer(y);\n.m7 { color : red }\n",
	'css/main8.css': "@import 'remote.css' layer(y) screen;\n.m8 { color : red }\n",
	// Layers of imported files: the same layer is one block, the layer statement
	// of an imported file goes in front under the conditions of the import.
	'css/layers.css': '@layer p, q;\n.layers { color : blue }\n',
	// Two layers in the conditions of one remote import, and anonymous layers.
	'css/mid.css': "@import 'remote.css' layer(b) print;\n.mid { color : blue }\n",
	'css/main10.css': "@import 'mid.css' layer(a) screen;\n.m10 { color : red }\n",
	'css/main11.css':
		"@import 'theme.css' layer;\n@import 'print.css' layer;\n.m11 { color : red }\n",
	'css/main9.css':
		"@import 'theme.css' layer(base);\n@import 'print.css' layer(base);\n@import 'layers.css' layer(y);\n.m9 { color : red }\n",
};

for (const [name, content] of Object.entries(FILES)) {
	mkdirSync(path.dirname(path.join(root, 'src', name)), { recursive: true });
	writeFileSync(path.join(root, 'src', name), content);
}
writeFileSync(
	path.join(root, 'kamado.config.jsonc'),
	JSON.stringify({
		dir: { input: 'src', output: 'out' },
		build: { cacheDir: '.cache' },
		styles: { banner: '', alias: { '@': './src/css' } },
		// The fixture has no pages and no scripts.
		scripts: { files: '**/*.nothing' },
	}),
);

const v3Config = path.join(root, 'kamado.config.jsonc');
execFileSync(
	'node',
	[path.join(repo, 'packages/kamado/dist/cli.js'), 'build', '--config', v3Config],
	{
		stdio: ['ignore', 'ignore', 'inherit'],
	},
);

/**
 * The output of v2's style compiler for one file.
 * @param {string} file - Absolute path of the stylesheet
 */
async function v2(file) {
	const processor = postcss([
		postcssImport({
			resolve: (id, basedir) => {
				for (const [alias, target] of Object.entries({
					'@': path.join(root, 'src/css'),
				})) {
					if (id.startsWith(alias + '/')) {
						return [path.resolve(basedir, id.replace(alias, target))];
					}
				}
				return [id];
			},
		}),
		cssnano({
			preset: [
				'default',
				{
					discardComments: { removeAll: false, removeAllButFirst: false },
					cssDeclarationSorter: false,
				},
			],
		}),
	]);
	const result = await processor.process('\n' + readFileSync(file, 'utf8'), {
		from: file,
		to: undefined,
	});
	return result.css;
}

/**
 * The outputs that differ from v2 on purpose, with what v3 writes and why. A
 * difference that is not listed here, or a v3 output that is not the one
 * listed, fails the check. Both sides are shown either way.
 * @type {Record<string, { v3: string; why: string }>}
 */
const INTENDED = {
	'main10.css': {
		v3: '@import "data:text/css;base64,QGltcG9ydCAnaHR0cHM6Ly9leGFtcGxlLmNvbS9mb250LmNzcycgbGF5ZXIoYikgcHJpbnQ=" layer(a) screen;@media screen{@layer a{@media print{@layer b{.remote{color:blue}}}}}@media screen{@layer a{.mid{color:blue}}}.m10{color:red}',
		why: 'the remote import is in the layer `a.b` (the import of `layer(a)` loads the sheet that imports it with `layer(b)`); postcss-import nests them the other way round, which is `b.a`',
	},
	'main11.css': {
		v3: '@layer{.theme{background:red;color:rgba(0,0,0,.5)}}@layer{.print{display:none}}.m11{color:red}',
		why: 'each anonymous layer is a layer of its own, so two of them side by side stay apart; cssnano joins adjacent `@layer` blocks, which puts the rules of one in the layer of the other',
	},
	'main9.css': {
		v3: '@layer base;@layer y{@layer p, q}@layer base{.theme{background:red;color:rgba(0,0,0,.5)}.print{display:none}}@layer y{.layers{color:blue}}.m9{color:red}',
		why: 'the layers are declared in the order of the imports (`base`, then `y`); postcss-import moves the `@layer` statement of an imported file in front, which declares `y` first',
	},
};

let failures = 0;
for (let n = 1; n <= 11; n++) {
	const input = path.join(root, 'src/css', `main${n}.css`);
	const expected = await v2(input);
	const actual = readFileSync(path.join(root, 'out/css', `main${n}.css`), 'utf8');
	const intended = INTENDED[`main${n}.css`];
	if (expected === actual) {
		console.log(`main${n}.css: identical (${actual.length} bytes)`);
	} else if (intended?.v3 === actual) {
		console.log(
			`main${n}.css: differs on purpose (${intended.why})\n  v2: ${expected}\n  v3: ${actual}`,
		);
	} else {
		failures++;
		console.log(`main${n}.css: differs\n  v2: ${expected}\n  v3: ${actual}`);
	}
}
rmSync(root, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
