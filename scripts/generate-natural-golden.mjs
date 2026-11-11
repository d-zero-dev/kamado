/**
 * Writes `crates/kd_core/tests/natural_golden.tsv`: how `numericalComparator` and
 * `pathComparator` of `@d-zero/shared` (`src/sort/`) order two strings, for the natural order
 * of the sort of `kamado ui` (RFC §14.2). The Rust port is `crates/kd_core/src/ui/natural.rs`,
 * whose test reads the file.
 *
 * What is compared is the result for a PAIR of values (`-1`, `0` or `1`), not the order of a
 * whole list: the comparison is not a total order (it drops the common prefix of each pair
 * before it reads a number, so `2a < 10b < 1c < 2a`), and the order a list ends in when it has a
 * cycle depends on the sort algorithm of the engine, which the port does not promise to copy.
 *
 * The values: URLs a kamado page can have and relative input paths written as `/dir/file`
 * (no host, no `//` at the start; RFC §6), and strings for `numericalComparator`, from the
 * hand-written lists below and from a fixed seed. A line is `kind<TAB>a<TAB>b<TAB>result`
 * with `\`, tab and newline escaped as `\\`, `\t` and `\n`; `kind` is `path` or `num`.
 *
 * `scripts/generate-natural-golden.spec.ts` fails while the committed file is not what this
 * writes. Run it when `@d-zero/shared` changes: `node scripts/generate-natural-golden.mjs`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { numericalComparator } from '@d-zero/shared/sort/numerical';
import { pathComparator } from '@d-zero/shared/sort/path';

import {
	createRng,
	randomUrl,
} from '../packages/kamado/src/page-data/random.test-util.ts';

import { isMain } from './is-main.mjs';

const root = path.resolve(import.meta.dirname, '..');

/** Where the golden is written. */
export const GOLDEN_FILE = path.join(
	root,
	'crates',
	'kd_core',
	'tests',
	'natural_golden.tsv',
);

/** The seed of the random values. */
const SEED = 4217;

/** URLs and input paths worth having whatever the generator makes. */
const FIXED_PATHS = [
	'/',
	'/index.html',
	'/a/',
	'/a.html',
	'/a/b/',
	'/a/b.html',
	'/a/index.html',
	'/a/INDEX.html',
	'/a/index.php',
	'/a/index-old/',
	'/a/2/',
	'/a/10/',
	'/a/1/',
	'/a/page2.html',
	'/a/page10.html',
	'/a/page1.html',
	'/a/Page2.html',
	'/a/b2/c.html',
	'/a/b10/c.html',
	'/a%20b/c.html',
	'/a b/c.html',
	'/x/%E3%81%82.html',
	'/x/あ.html',
	'/x/い.html',
	'/x/😀.html',
	'/x/～.html',
	'/a/b.tar.gz',
	'/a/b.html.bak',
	'/a/.hidden',
	'/a/b.',
	'/a//b.html',
	'/a/./b.html',
	'/a/../b.html',
	'/a/%2e%2e/b.html',
	'/a\\b.html',
	'/a/b%2Fc.html',
	'/a/b%zz.html',
	'/a?',
	'/a#',
	'/a/b?x=1',
	'/a/b#top',
	'/a/b.html?x=2#y',
	'/a/`b{c}^d.html',
];

/** Strings for `numericalComparator`. */
const FIXED_STRINGS = [
	'',
	'0',
	'1',
	'2',
	'10',
	'-1',
	'+3',
	'1.5',
	'1.25',
	'.5',
	'5.',
	'1e3',
	'1e',
	'1E+2',
	' 7',
	'\t8',
	'a\tb',
	'a\nb',
	'Infinity',
	'-Infinity',
	'1e999',
	'a',
	'A',
	'b',
	'a1',
	'a2',
	'a10',
	'A10',
	'page2',
	'page10',
	'2a',
	'10b',
	'1c',
	'abc',
	'abd',
	'abc1',
	'abc 1',
	'true',
	'false',
	'あ',
	'い',
	'あ1',
	'あ10',
	'😀',
	'～',
	'İ',
	'İ1',
	'ΑΣ',
	'ΑΣ ',
	'%E3%81%82',
	'%e3%81%82',
	'あ',
	'a%20b',
	'a b',
	'a%2Fb',
	'a/b',
	'%zz',
	'%E3%81',
	'[1,2]',
	'[1,10]',
	'{"a":1}',
];

/**
 * @param {string} text - A value
 * @returns {string} `\`, tab and newline written as `\\`, `\t` and `\n`
 * @example
 * escape('a\tb'); // 'a\\tb'
 */
export function escape(text) {
	return text.replaceAll('\\', '\\\\').replaceAll('\t', '\\t').replaceAll('\n', '\\n');
}

/**
 * @param {number} n - What a comparator returned
 * @returns {-1 | 0 | 1} Its sign
 * @example
 * sign(-5); // -1
 */
function sign(n) {
	return n < 0 ? -1 : n > 0 ? 1 : 0;
}

/**
 * The values of the golden: the hand-written ones, then the random ones that are new.
 * @returns {{ paths: string[], strings: string[] }} Each value once
 * @example
 * values().paths[0]; // '/'
 */
export function values() {
	const rng = createRng(SEED);
	const paths = [...new Set(FIXED_PATHS)];
	const seenPaths = new Set(paths);
	for (let i = 0; i < 60; i++) {
		const url = randomUrl(rng);
		if (!seenPaths.has(url)) {
			seenPaths.add(url);
			paths.push(url);
		}
	}
	const strings = [...new Set(FIXED_STRINGS)];
	const seen = new Set(strings);
	const alphabet = ['a', 'b', 'A', '0', '1', '2', '9', '.', ' ', '-', 'あ'];
	for (let i = 0; i < 40; i++) {
		let s = '';
		for (let n = rng.int(0, 6); n > 0; n--) {
			s += rng.pick(alphabet);
		}
		if (!seen.has(s)) {
			seen.add(s);
			strings.push(s);
		}
	}
	return { paths, strings };
}

/**
 * The text of the golden file.
 * @returns {string} A line for each ordered pair of values of a kind
 * @example
 * render().split('\n')[0].startsWith('path\t'); // true
 */
export function render() {
	const { paths, strings } = values();
	const lines = [];
	for (const a of paths) {
		for (const b of paths) {
			lines.push(`path\t${escape(a)}\t${escape(b)}\t${sign(pathComparator(a, b))}`);
		}
	}
	for (const a of strings) {
		for (const b of strings) {
			lines.push(`num\t${escape(a)}\t${escape(b)}\t${sign(numericalComparator(a, b))}`);
		}
	}
	return `${lines.join('\n')}\n`;
}

if (isMain(import.meta.filename)) {
	mkdirSync(path.dirname(GOLDEN_FILE), { recursive: true });
	writeFileSync(GOLDEN_FILE, render());
}
