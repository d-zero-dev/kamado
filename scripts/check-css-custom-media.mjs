/**
 * Differential check of `@custom-media`: each case is resolved by v2's style
 * compiler pipeline (postcss-custom-media, the version `@d-zero/postcss-config`
 * pins, then cssnano as `scripts/css-oracle.mjs` runs it) and by `kd_css`, and
 * the outputs are compared after cssnano has minified the `kd_css` output too
 * (the two minifiers write the same rules in different bytes; see
 * `scripts/check-css.mjs`).
 *
 * Usage:
 *   cargo build --release --offline -p kd_css --example minify
 *   node scripts/check-css-custom-media.mjs
 *
 * The outputs must be the same, except where Media Queries 5 and
 * postcss-custom-media disagree (`docs/v3/RFC.md` §2 #37); those are listed as
 * "differs" with both sides, never hidden. The exit code is 1 when a case
 * fails.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import postcss from 'postcss';
import postcssCustomMedia from 'postcss-custom-media';

import { cssnanoMinify } from './css-oracle.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const binary = path.join(repo, 'target', 'release', 'examples', 'minify');

/** The cases: what a definition stands for, where a reference stands. */
const CASES = [
	// A query that is only the reference, and a feature written in place.
	'@custom-media --md-lte (width < 992px);\n@media (--md-lte) { a { top: 0 } }',
	'@custom-media --l (width < 1px), print;\n@custom-media --c (width >= 1px) and (hover);\n@media (--l) { a { top: 0 } }\n@media ( --c ) { b { top: 0 } }',
	'@custom-media --sm (576px <= width);\na { @media screen and (--sm) and (hover) { top: 0 } }',
	'@custom-media --a (width < 1px);\n@media not (--a) { b { top: 0 } }',
	'@custom-media --narrow (width < 100px);\n@custom-media --wide (not (--narrow));\n@media (--wide) { a { top: 0 } }\n@media (not (--narrow)) { b { left: 0 } }',
	'@custom-media --a ((width < 1px));\n@media ((--a) and (hover)) { a { top: 0 } }\n@media (not ( --a )) { b { left: 0 } }',
	'@custom-media --a (min-width:calc(1px + 2px));\n@media (not (--a)) { a { top: 0 } }',
	'@custom-media --b (--a) and (hover);\n@custom-media --a (width < 1px);\n@media (--b) { a { top: 0 } }',
	'@custom-media --t true;\n@custom-media --f FALSE;\n@media not (--t) { a { top: 0 } }\n@media (--f) and (hover) { b { top: 0 } }',
	// The rule written for when the definition matches and when it does not.
	'@custom-media --wide (width >= 1px), print;\n@media (--wide) and (hover) { a { top: 0 } b { left: 0 } }',
	'@custom-media --l (width < 1px), print;\n@media (not (--l)) { a { top: 0 } }\n@media (--l) or (color) { b { left: 0 } }',
	'@custom-media --a (width >= 1px) and (hover);\n@media (not (--a)) { a { top: 0 } }\n@media NOT (--a) { b { top: 0 } }\n@media (--a) OR (color) { c { top: 0 } }',
	'@custom-media --s screen;\n@custom-media --o only screen and (hover);\n@media not (--s) { a { top: 0 } }\n@media (--o) and (color) { b { top: 0 } }',
	'@custom-media --n not (hover);\n@custom-media --p not print;\n@media (--n) and (color) { a { top: 0 } }\n@media (--p) and (color) { b { top: 0 } }',
	'@custom-media --a (x:1) or (y:1);\n@media (--a) and (hover) { a { top: 0 } }',
	'@custom-media --l (width < 1px), print;\n@media (width > calc(1px + 1px)) and (--l) { a { top: 0 } }',
	'@custom-media --l (width < 1px), print;\n@custom-media --m (hover), screen;\n@media (--l) and (--m) { a { top: 0 } }',
	'@custom-media --l (width < 1px), print;\n@custom-media --a (hover);\n@media (--l), (--a) and (--l) { a { top: 0 } }',
	'@custom-media --l (width < 1px), print;\n@media screen, (--l) and (hover) { a { top: 0 } }',
	'@custom-media --l (width < 1px), print;\na { color: red; @media (--l) and (hover) { top: 0 } }',
	'@custom-media --l (width < 1px), print;\n@supports (display: grid) { @media not (--l) { a { top: 0 } } }',
	'@custom-media --x (--y) and (hover);\n@custom-media --y (width < 1px), print;\n@media not (--x) { a { top: 0 } }',
	'@custom-media --c (x:1), print;\n@custom-media --a (--c);\n@custom-media --b (--a) or (hover);\n@media (--b) { a { top: 0 } }',
	'@custom-media --a (min-width: 768px) and (max-width: 991px);\n@media not all and (--a) { a { top: 0 } }',
	'@custom-media --l (x:1), print;\n@media layer and (--l) { a { top: 0 } }',
	'@custom-media --a (x:1);\n@media (--a) and (y: "(") { a { top: 0 } }',
	// What stays as written.
	'@custom-media --a (width < 1px);\n@media (--b), print { a { top: 0 } }\n@media (--a) and (--b) { b { top: 0 } }',
	'@custom-media --u (--undefined) and (hover);\n@media (not (--u)) { a { top: 0 } }',
	'@custom-media --l (x:1), print;\n@media cannot (--l) { a { top: 0 } }\n@media (--l) foo { b { top: 0 } }\n@media screen (--l) { c { top: 0 } }',
	'@custom-media --l (x:1), print;\n@media (a) and (b) or (--l) { a { top: 0 } }\n@media (a) only (--l) { b { top: 0 } }',
	'@custom-media --a (x:1);\n@media (c) and foo(y) and (--a) { a { top: 0 } }\n@media not(--a) { b { top: 0 } }\n@media screen and(--a) { c { top: 0 } }',
	'@custom-media --l (x:1), print;\n@media (foo (--l)) { a { top: 0 } }\n@media (foo: (--l)) { b { top: 0 } }\n@media (width > calc((--l))) { c { top: 0 } }',
	'@custom-media --md (width < 992px);\n@media (min-width: var(--md)) { a { top: 0 } }',
	'@custom-media foo (width < 1px);\n@custom-media --a;\n@media (--foo) { a { top: 0 } }\n@media (--a) { b { top: 0 } }',
	// Where a definition counts.
	'@media screen { @custom-media --a (width < 1px); }\n@supports (display: grid) { @custom-media --b (hover); }\n@starting-style { @custom-media --c (x:1); }\n@media (--a) and (--b) and (--c) { a { top: 0 } }',
	'@container x { @custom-media --a (x:1); }\n@scope (.a) { @custom-media --b (y:1); }\na { @custom-media --c (z:1); }\n@media (--a) and (--b) and (--c) { a { top: 0 } }',
	'@custom-media --a (x:1);\n@custom-media --a (y:1);\n@media (--a) { a { top: 0 } }',
];

/**
 * The cases whose outputs differ from v2 on purpose, where Media Queries 5
 * and postcss-custom-media disagree: the input, what v3 writes (after
 * cssnano) and why. A v3 output that is not the one listed fails the check.
 * The strings carry the formatting of the cssnano that is pinned (`(--a )`),
 * so a move of its version can fail them on format alone.
 * @type {{ css: string; v3: string; why: string }[]}
 */
const INTENDED = [
	{
		css: '@custom-media --a (--b);\n@custom-media --b (--a);\n@media (--a) { a { top: 0 } }',
		v3: '@media (--a ){a{top:0}}',
		why: 'every definition of a loop is undefined (Media Queries 5 §10); postcss-custom-media drops one name of the loop and resolves the other',
	},
	{
		css: '@custom-media --a (not (--a));\n@custom-media --b (--c) and (hover);\n@custom-media --c (not (--b));\n@custom-media --d (--a);\n@media (--a) { a { top: 0 } }\n@media (--b) { b { top: 0 } }\n@media (--d) { c { top: 0 } }',
		v3: '@media (--a ){a{top:0}}@media (--b ){b{top:0}}@media (--a ){c{top:0}}',
		why: 'every definition of a loop is undefined; postcss-custom-media resolves `--b` one step to `(--c) and (hover)`',
	},
	{
		css: '@custom-media --x (min-width: var(--x));\n@media (--x) { a { top: 0 } }',
		v3: '@media (min-width:var(--x )){a{top:0}}',
		why: 'the argument of `var()` is no reference; postcss-custom-media counts it and takes `--x` for a loop',
	},
	{
		css: '@custom-media --q not screen and (hover);\n@media (--q) and (color) { a { top: 0 } }',
		v3: '@media not screen and (hover){@media (max-color:2147477350) and (color){a{top:0}}}@media screen and (hover){@media (color:2147477350) and (color){a{top:0}}}',
		why: 'the negation of `not screen and (hover)` is `screen and (hover)`; postcss-custom-media writes `(hover),screen`, which matches more',
	},
	{
		css: '@custom-media --a foo(x);\n@custom-media --b not(hover);\n@custom-media --x (ab) not;\n@media not (--a) { a { top: 0 } }\n@media not (--b) { b { top: 0 } }\n@media not (--x) { c { top: 0 } }',
		v3: '@media foo(x){@media not (max-color:2147477350){a{top:0}}}@media{@media not (color:2147477350){a{top:0}}}@media not(hover){@media not (max-color:2147477350){b{top:0}}}@media{@media not (color:2147477350){b{top:0}}}@media (ab) not{@media not (max-color:2147477350){c{top:0}}}@media{@media not (color:2147477350){c{top:0}}}',
		why: 'a definition that never matches makes `(--a)` false, so `not (--a)` always applies (the negation is `all`); postcss-custom-media writes the definition again as its negation, so the rule never applies',
	},
	{
		css: '@layer x, y;\n@layer y { @custom-media --a (width < 1px); }\n@layer x { @custom-media --a (width > 2px); }\n@media (--a) { a { top: 0 } }',
		v3: '@layer x, y;@layer y{}@layer x{}@media (width > 2px){a{top:0}}',
		why: 'the last definition of a name is the one (Media Queries 5 §10); postcss-custom-media takes the one in the layer of the highest priority',
	},
	{
		css: '@layer x { @custom-media --a (width < 1px); }\n@media (--a) { a { top: 0 } }',
		v3: '@layer x{}@media (width < 1px){a{top:0}}',
		why: 'the emptied `@layer x {}` stays, as it places the layer; postcss-custom-media removes it',
	},
	{
		css: '@custom-media -- (x:1);\n@media (--) { a { top: 0 } }',
		v3: '@custom-media -- (x:1);@media (-- ){a{top:0}}',
		why: '`--` alone is reserved (CSS Values 4); postcss-custom-media defines it',
	},
];

/** @type {{ css: string; v3?: string; why?: string }[]} */
const ALL = [...CASES.map((css) => ({ css })), ...INTENDED];

const dir = mkdtempSync(path.join(tmpdir(), 'kamado-custom-media-'));
const files = ALL.map(({ css }, i) => {
	const file = path.join(dir, `${i}.css`);
	writeFileSync(file, css);
	return file;
});
const run = spawnSync(binary, [], { input: `${files.join('\n')}\n`, encoding: 'utf8' });
rmSync(dir, { recursive: true, force: true });
if (run.status !== 0) {
	throw new Error(`minify example failed (build it first): ${run.stderr || run.error}`);
}
const v3 = new Map();
for (const line of run.stdout.split('\n').filter(Boolean)) {
	const result = JSON.parse(line);
	v3.set(result.path, result.css ?? `__ERROR__ ${result.error}`);
}

let failures = 0;
for (const [i, { css, v3: intended, why }] of ALL.entries()) {
	const resolved = await postcss([postcssCustomMedia()]).process(css, {
		from: undefined,
	});
	const v2 = await cssnanoMinify(resolved.css);
	const mine = await cssnanoMinify(v3.get(files[i]));
	const ok = mine === (intended ?? v2);
	if (!ok) {
		failures++;
	}
	const status = ok ? (intended === undefined ? 'same' : 'differs') : 'FAIL';
	process.stdout.write(`${status} ${i}: ${JSON.stringify(css)}\n`);
	if (!ok || intended !== undefined) {
		process.stdout.write(`  v2: ${v2}\n  v3: ${mine}\n`);
		if (why) {
			process.stdout.write(`  why: ${why}\n`);
		}
	}
}
process.stdout.write(`${ALL.length - failures}/${ALL.length} as expected\n`);
process.exitCode = failures === 0 ? 0 : 1;
