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
		"@import 'base/index.css';\n@import url(\"theme.css\");\n.main { padding : 0px 0px 0px 0px }\n",
	'css/main2.css':
		"@import 'theme.css' screen and (min-width: 600px);\n@import 'print.css' print;\n@import 'base/reset.css';\n.m2 { margin : 10px }\n",
	'css/main3.css':
		'@charset "utf-8";\n@import \'theme.css\';\n@import \'theme.css\';\n.m3 { font-weight : normal }\n',
	'css/main4.css': "@import '@/theme.css';\n.m4 { top : 0px }\n",
	'css/main5.css': "@import 'base/index.css';\n@import 'base/reset.css';\n.m5{}\n",
	'node_modules/pkg/package.json': '{ "name": "pkg", "style": "dist/pkg.css" }',
	'node_modules/pkg/dist/pkg.css': '.pkg { color : blue }\n',
	'css/main6.css': "@import 'pkg';\n.m6 { color : red }\n",
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
execFileSync('node', [path.join(repo, 'packages/kamado-v3/dist/cli.js'), 'build', '--config', v3Config], {
	stdio: ['ignore', 'ignore', 'inherit'],
});

/**
 * The output of v2's style compiler for one file.
 * @param {string} file - Absolute path of the stylesheet
 */
async function v2(file) {
	const processor = postcss([
		postcssImport({
			resolve: (id, basedir) => {
				for (const [alias, target] of Object.entries({ '@': path.join(root, 'src/css') })) {
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
				{ discardComments: { removeAll: false, removeAllButFirst: false }, cssDeclarationSorter: false },
			],
		}),
	]);
	const result = await processor.process('\n' + readFileSync(file, 'utf8'), {
		from: file,
		to: undefined,
	});
	return result.css;
}

let failures = 0;
for (let n = 1; n <= 6; n++) {
	const input = path.join(root, 'src/css', `main${n}.css`);
	const expected = await v2(input);
	const actual = readFileSync(path.join(root, 'out/css', `main${n}.css`), 'utf8');
	if (expected === actual) {
		console.log(`main${n}.css: identical (${actual.length} bytes)`);
	} else {
		failures++;
		console.log(`main${n}.css: differs\n  v2: ${expected}\n  v3: ${actual}`);
	}
}
rmSync(root, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
