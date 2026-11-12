/**
 * Writes `crates/kd_core/tests/order_golden.tsv`: the number the meta key `order` of a page
 * is read as when it is a string (RFC §6), which is what the engine makes of it:
 * `Number.isFinite(parseFloat(s)) ? parseFloat(s) : 0`. The Rust port is `order_of` and
 * `parse_float` of `crates/kd_core/src/nav_order.rs`, whose test reads the file.
 *
 * A line is `string<TAB>number`: the string as JSON (so that a tab, a newline and the spaces
 * `parseFloat` skips are written as they are in the escaped form, and read back by the JSON
 * parser of the core), and the number as `String(number)`. The values are the hand-written
 * ones below and ones made from a fixed seed.
 *
 * `scripts/generate-order-golden.spec.ts` fails while the committed file is not what this
 * writes. Run it when the engine changes: `node scripts/generate-order-golden.mjs`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createRng } from '../packages/kamado/src/page-data/random.test-util.ts';

import { isMain } from './is-main.mjs';

const root = path.resolve(import.meta.dirname, '..');

/** Where the golden is written. */
export const GOLDEN_FILE = path.join(
	root,
	'crates',
	'kd_core',
	'tests',
	'order_golden.tsv',
);

/** The seed of the random values. */
const SEED = 9051;

/** Strings worth having whatever the generator makes. */
const FIXED = [
	'',
	' ',
	'0',
	'-0',
	'1',
	'2',
	'03',
	'007',
	'10',
	'-1',
	'+3',
	'+',
	'-',
	'.',
	'-.',
	'+.5',
	'1.5',
	'1.25',
	'.5',
	'5.',
	'5.e2',
	'.e2',
	'1e3',
	'1e',
	'1e+',
	'1e-',
	'1e+2',
	'1e-2',
	'1E3',
	'1E+2',
	'1e999',
	'-1e999',
	'1e-999',
	'123456789012345678901234567890',
	'0.1',
	'0.30000000000000004',
	' 7',
	'  7  ',
	'\t8',
	'\n9',
	'\r\n9',
	'\u000B3',
	'\u000C4',
	' 5',
	' 6',
	' 7',
	' 8',
	' 9',
	' -1',
	' -2',
	' 3',
	' 4',
	'　5',
	'﻿6',
	'\u00857',
	'᠎8',
	'​9',
	'7 8',
	'7\t8',
	'3abc',
	'-4abc',
	'3.5.6',
	'3-4',
	'3+4',
	'1,5',
	'1_000',
	'0x10',
	'0X10',
	'0b11',
	'0o7',
	'00x1',
	'Infinity',
	'-Infinity',
	'+Infinity',
	'infinity',
	'NaN',
	'abc',
	'a1',
	'true',
	'false',
	'null',
	'undefined',
	'[1]',
	'{"a":1}',
	'１',
	'３',
	'１２',
	'1２',
	'あ1',
	'1あ',
	'😀1',
	'1😀',
];

/**
 * @param {string} text - A value
 * @returns {number} The number the engine reads it as, `0` when it is not a finite one
 * @example
 * orderOf('03'); // 3
 * orderOf('abc'); // 0
 */
export function orderOf(text) {
	const number = Number.parseFloat(text);
	return Number.isFinite(number) ? number : 0;
}

/**
 * The values of the golden: the hand-written ones, then the random ones that are new.
 * @returns {string[]} Each value once
 * @example
 * values()[0]; // ''
 */
export function values() {
	const rng = createRng(SEED);
	const strings = [...new Set(FIXED)];
	const seen = new Set(strings);
	const alphabet = [
		'0',
		'1',
		'2',
		'5',
		'9',
		'.',
		'e',
		'E',
		'+',
		'-',
		' ',
		'\t',
		'a',
		'x',
		' ',
		'あ',
	];
	for (let i = 0; i < 200; i++) {
		let s = '';
		for (let n = rng.int(0, 8); n > 0; n--) {
			s += rng.pick(alphabet);
		}
		if (!seen.has(s)) {
			seen.add(s);
			strings.push(s);
		}
	}
	return strings;
}

/**
 * The text of the golden file.
 * @returns {string} A line for each value
 * @example
 * render().split('\n')[0]; // '""\t0'
 */
export function render() {
	const lines = values().map((s) => `${JSON.stringify(s)}\t${String(orderOf(s))}`);
	return `${lines.join('\n')}\n`;
}

if (isMain(import.meta.filename)) {
	mkdirSync(path.dirname(GOLDEN_FILE), { recursive: true });
	writeFileSync(GOLDEN_FILE, render());
}
