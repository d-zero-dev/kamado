/**
 * Generates `crates/kd_html/src/entities_table.rs` from the WHATWG named
 * character references.
 *
 * Source of truth: the `character-entities` package, which carries the WHATWG
 * `entities.json` data. It is a dev-time input only; the generated Rust file
 * is committed so that the runtime has no dependency on it. Run this when the
 * package version is bumped: `node scripts/generate-entities.mjs`, then
 * `cargo fmt --all` (the committed table is formatted).
 * `scripts/generate-entities.spec.ts` fails while the committed table is not what
 * it writes, apart from the formatting and the version in the header: that
 * records the character-entities the table was last generated from, so a release
 * that leaves the references as they are passes without a regeneration.
 *
 * Three tables are written:
 * - `DECODE`: every name WITHOUT the leading `&` and trailing `;` mapped to its
 *   replacement text, sorted by name for binary search.
 * - `LEGACY`: the names the HTML spec accepts without a trailing semicolon.
 * - `ENCODE`: replacement character → preferred entity name for non-ASCII
 *   output. The preference rule is the one v2's `characterEntities` used:
 *   skip code points below 127, prefer the lowercase spelling when both cases
 *   map to the same character, and keep the first definition otherwise.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { characterEntities } from 'character-entities';

import { isMain } from './is-main.mjs';

/**
 * The 106 names HTML accepts without a semicolon (the spec's "named character
 * references" table, entries listed without `;`). A fixed list in the spec, so
 * it is written out here rather than pulled from another package.
 */
const LEGACY_NAMES = [
	...'AElig AMP Aacute Acirc Agrave Aring Atilde Auml COPY Ccedil ETH Eacute Ecirc Egrave Euml GT Iacute Icirc Igrave Iuml LT Ntilde Oacute Ocirc Ograve Oslash Otilde Ouml QUOT REG THORN Uacute Ucirc Ugrave Uuml Yacute'.split(
		' ',
	),
	...'aacute acirc acute aelig agrave amp aring atilde auml brvbar ccedil cedil cent copy curren deg divide eacute ecirc egrave eth euml frac12 frac14 frac34 gt iacute icirc iexcl igrave iquest iuml laquo lt macr micro middot nbsp not ntilde oacute ocirc ograve ordf ordm oslash otilde ouml para plusmn pound quot raquo reg sect shy sup1 sup2 sup3 szlig thorn times uacute ucirc ugrave uml uuml yacute yen yuml'.split(
		' ',
	),
];

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'crates', 'kd_html', 'src', 'entities_table.rs');

/**
 * Reads what the table is made from.
 * @returns {{ entities: Record<string, string>, version: string }} The references of
 * character-entities and its version
 * @example
 * const { entities, version } = readSources();
 */
export function readSources() {
	return {
		entities: characterEntities,
		version: JSON.parse(
			readFileSync(
				path.join(root, 'node_modules/character-entities/package.json'),
				'utf8',
			),
		).version,
	};
}

/**
 * Renders a string as a Rust string literal using only ASCII.
 * @param {string} s - The text
 * @returns {string} A Rust literal
 */
function rustString(s) {
	let r = '"';
	for (const ch of s) {
		const cp = ch.codePointAt(0);
		if (ch === '"' || ch === '\\') {
			r += `\\${ch}`;
		} else if (cp < 0x20 || cp >= 0x7f) {
			r += `\\u{${cp.toString(16)}}`;
		} else {
			r += ch;
		}
	}
	return `${r}"`;
}

/**
 * The text of `entities_table.rs`, before `cargo fmt`.
 * @param {{ entities: Record<string, string>, version: string }} sources - From
 * {@link readSources}; `version` is the one the header names
 * @returns {{ text: string, names: number, legacy: number, encodable: number }} The
 * file, and how many references, legacy names and encodable characters it has
 * @example
 * const { text } = renderEntities(readSources());
 */
export function renderEntities({ entities, version }) {
	const names = Object.keys(entities).toSorted();
	const legacyNames = LEGACY_NAMES.toSorted();
	if (legacyNames.length !== 106 || legacyNames.some((n) => entities[n] === undefined)) {
		throw new Error('the legacy list must have 106 entries, all of them known names');
	}

	// ENCODE: v2's reverse map, in v2's iteration order.
	const encode = new Map();
	for (const [entity, char] of Object.entries(entities)) {
		const codePoint = char.codePointAt(0);
		if (codePoint == null || codePoint < 127) {
			continue;
		}
		// Only single code points are encodable. v2 matched with a regex built from
		// the characters, which in effect replaced one code point at a time, so a
		// reference whose text is a base plus a combining mark (`&nang;`) never
		// appeared in its output; emitting it would change the output.
		// oxlint-disable-next-line typescript/no-misused-spread -- the code points on purpose, not the units of a string
		if ([...char].length !== 1) {
			continue;
		}
		const preferred =
			/^[A-Z]+$/i.test(entity) && entities[entity.toLowerCase()] === char
				? entity.toLowerCase()
				: entity;
		if (!encode.has(char)) {
			encode.set(char, preferred);
		}
	}
	// Sort by UTF-8 bytes: that is how Rust compares `&str`, which the runtime's
	// binary search relies on. JavaScript's default string order is by UTF-16 code
	// unit and differs from it for characters outside the Basic Multilingual Plane.
	const encodeSorted = [...encode.entries()].toSorted(([a], [b]) =>
		Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')),
	);

	const lines = [
		'// @generated by scripts/generate-entities.mjs — do not edit by hand.',
		`// Source: character-entities ${version} (WHATWG named character references).`,
		'',
		'/// Named references (without `&` and `;`) → replacement text, sorted by name.',
		`pub static DECODE: [(&str, &str); ${names.length}] = [`,
		...names.map((name) => `\t(${rustString(name)}, ${rustString(entities[name])}),`),
		'];',
		'',
		'/// Names that the HTML spec also accepts without a trailing semicolon, sorted.',
		`pub static LEGACY: [&str; ${legacyNames.length}] = [`,
		...legacyNames.map((name) => `\t${rustString(name)},`),
		'];',
		'',
		'/// Non-ASCII character → preferred entity name, sorted by character.',
		`pub static ENCODE: [(&str, &str); ${encodeSorted.length}] = [`,
		...encodeSorted.map(
			([char, name]) => `\t(${rustString(char)}, ${rustString(name)}),`,
		),
		'];',
		'',
	];
	return {
		text: lines.join('\n'),
		names: names.length,
		legacy: legacyNames.length,
		encodable: encodeSorted.length,
	};
}

/**
 * Writes the table of the installed character-entities.
 * @param {string} [output] - Where to write it
 * @returns {string} What to report: the file, the counts and the start of its hash
 * @example
 * process.stdout.write(generate()); // writes crates/kd_html/src/entities_table.rs
 */
export function generate(output = out) {
	const { text, names, legacy, encodable } = renderEntities(readSources());
	writeFileSync(output, text);
	return `wrote ${path.relative(root, output)}: ${names} names, ${legacy} legacy, ${encodable} encodable (sha256 ${createHash('sha256').update(text).digest('hex').slice(0, 16)})\n`;
}

if (isMain(import.meta.filename)) {
	process.stdout.write(generate());
}
