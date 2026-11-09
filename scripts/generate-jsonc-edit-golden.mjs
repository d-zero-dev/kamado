/**
 * Writes the golden cases of `kd_jsonc::edit` (`crates/kd_jsonc/tests/edit_golden.json`): JSONC
 * texts in many layouts (inline, one member per line, tabs or spaces, trailing commas, comments,
 * CRLF, nested objects and arrays), an edit of each kind (set an existing key, add a key, delete
 * a key) at every object of the text, and what `jsonc-parser` (the library VS Code edits JSONC
 * with, the oracle) makes of it, as the value the edited text must read as.
 *
 * What is compared is the value and not the bytes: the oracle formats what it inserts with its
 * own rules, and `kd_jsonc::edit` follows the layout of the file it edits (its unit tests
 * check the bytes). `crates/kd_jsonc/tests/edit_golden.rs` checks `kd_jsonc::edit` against the
 * file; `scripts/generate-jsonc-edit-golden.spec.ts` fails while the committed file is not
 * what this writes. Run it when `jsonc-parser` is upgraded or a case is added:
 * `node scripts/generate-jsonc-edit-golden.mjs`.
 */
import { realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { applyEdits, modify, parse } from 'jsonc-parser';

/** Where the golden is written. */
export const GOLDEN_FILE = path.resolve(
	import.meta.dirname,
	'..',
	'crates',
	'kd_jsonc',
	'tests',
	'edit_golden.json',
);

const bases = [
	'{}',
	'{"a":1}',
	'{ "a": 1, "b": [1, 2], "c": { "d": null } }',
	'{\n\t"a": 1,\n\t"b": "x"\n}\n',
	'{\n  "a": 1,\n  "b": 2,\n}\n',
	'// head\n{\n\t// a\n\t"a": 1, // one\n\t/* b */ "b": 2\n}\n',
	'{\n\t"o": {\n\t\t"x": 1,\n\t\t"y": [\n\t\t\t1,\n\t\t\t2\n\t\t]\n\t},\n\t"z": true\n}\n',
	'{\r\n\t"a": 1,\r\n\t"b": 2\r\n}\r\n',
	'{\n\t"version": 1,\n\t"pages": [\n\t\t{ "url": "/a/", "meta": { "t": 1 } },\n\t\t{ "url": "/b/", "virtual": true }\n\t]\n}\n',
	'{"version":1,"pages":[{"url":"/a/"}]}',
	'{"a":{},"b":[]}',
	'{"日本語": "値", "e": "\\u00e9", "q": "a\\"b"}',
	'{"k\\"ey": 1, "back\\\\slash": {"n": 2}}',
	'{\n\t"a": [\n\t],\n\t"b": {\n\t}\n}\n',
	'{ "a": 1 /* tail */ }',
	'{\n\t"a": 1 // last, no comma\n}\n',
];

const values = [
	'v',
	'日本語',
	'with "quote" and \\ and\nnewline',
	7,
	-3,
	1.5,
	-0.25,
	1e21,
	1e-7,
	true,
	false,
	null,
	[1, 'two', null],
	{ k: 'v', n: { m: 1 } },
	[],
	{},
];

/**
 * Every container of a value, as a path from the root.
 * @param {unknown} value the parsed text
 * @param {(string | number)[]} at the path of `value`
 * @returns {{ path: (string | number)[], value: unknown }[]} the objects and arrays
 * @example
 * containers({ a: [1] }).map((c) => c.path); // [[], ['a']]
 */
export function containers(value, at = []) {
	if (value === null || typeof value !== 'object') {
		return [];
	}
	const here = [{ path: at, value }];
	const entries = Array.isArray(value)
		? value.map((v, i) => [i, v])
		: Object.entries(value);
	return [...here, ...entries.flatMap(([k, v]) => containers(v, [...at, k]))];
}

const formattingOptions = { insertSpaces: false, tabSize: 1, eol: '\n' };

/**
 * What the oracle makes of an edit, as the JSON the result must read as.
 * @param {string} text the JSONC text
 * @param {(string | number)[]} jsonPath the path of the value to set (or `undefined` to delete)
 * @param {unknown} value the new value, or `undefined` to delete
 * @returns {string} compact JSON
 * @example
 * expected('{"a":1}', ['a'], 2); // '{"a":2}'
 */
export function expected(text, jsonPath, value) {
	const edits = modify(text, jsonPath, value, { formattingOptions });
	const result = applyEdits(text, edits);
	return JSON.stringify(parse(result, [], { allowTrailingComma: true }));
}

/**
 * The cases of the golden: for every object of every text, a set of each key to each value,
 * a delete of each key, and an add of a new key with each value.
 * @returns {object[]} The cases
 * @example
 * cases()[0].op; // 'set'
 */
export function cases() {
	const out = [];
	for (const text of bases) {
		const root = parse(text, [], { allowTrailingComma: true });
		for (const { path: at, value } of containers(root)) {
			if (Array.isArray(value)) {
				continue;
			}
			for (const key of Object.keys(value)) {
				for (const v of values) {
					out.push({
						text,
						op: 'set',
						path: at,
						key,
						value: v,
						expected: expected(text, [...at, key], v),
					});
				}
				out.push({
					text,
					op: 'delete',
					path: at,
					key,
					expected: expected(text, [...at, key]),
				});
			}
			for (const v of values) {
				out.push({
					text,
					op: 'set',
					path: at,
					key: 'added',
					value: v,
					expected: expected(text, [...at, 'added'], v),
				});
			}
		}
	}
	return out;
}

/**
 * The text of the golden file.
 * @returns {string} The cases as JSON, one tab of indentation
 * @example
 * render().startsWith('['); // true
 */
export function render() {
	return `${JSON.stringify(cases(), null, '\t')}\n`;
}

if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) {
	writeFileSync(GOLDEN_FILE, render());
	console.log(
		`wrote ${cases().length} cases to ${path.relative(process.cwd(), GOLDEN_FILE)}`,
	);
}
