import type { Cell, Row } from '../types.js';
import type { EnumKind } from './kinds.js';
import type { FieldKind } from './value.js';

import { kindOf } from './value.js';

/**
 * The columns of the screen after the fixed ones: the keys of the pages, and the keys that
 * were added in the dialog and no page has yet, in the order of their names' UTF-16 code
 * units. The core orders its own by bytes (UTF-8); the two orders agree for every name made
 * of characters below U+10000, and a name with a character above it (an emoji) can be put
 * differently here from the core's order. That is fine: the order of the columns is for
 * reading only, and nothing else depends on it.
 * @param fromPages - `columns` of the core
 * @param added - The keys added on the screen
 * @example
 * ```ts
 * metaColumns(['layout', 'title'], ['Draft']);
 * // ['Draft', 'layout', 'title']
 * ```
 */
export function metaColumns(
	fromPages: readonly string[],
	added: readonly string[],
): string[] {
	return [...new Set([...fromPages, ...added])].toSorted((a, b) =>
		a < b ? -1 : a > b ? 1 : 0,
	);
}

/**
 * The part of an edit request that says which file versions the edit was made on: all three
 * hashes of the page. The core compares only those the edit touches.
 * @param row - The row
 * @param overridesHash - `overridesHash` of the list
 * @example
 * ```ts
 * expectOf(row, 'abc'); // { input: '…', sidecar: null, overrides: 'abc' }
 * ```
 */
export function expectOf(
	row: Pick<Row, 'hashes'>,
	overridesHash: string | null,
): { input: string | null; sidecar: string | null; overrides: string | null } {
	return {
		input: row.hashes.input,
		sidecar: row.hashes.sidecar,
		overrides: overridesHash,
	};
}

/**
 * The cell of a key in a row, and the kind of input that edits it: from the value when the
 * page has the key, from the kind the key was added as (or text) when it has not.
 * @param row - The row
 * @param key - The key
 * @param addedKinds - The kinds chosen for keys added on the screen
 * @example
 * ```ts
 * cellOf({ meta: {} }, 'draft', new Map([['draft', 'boolean']]));
 * // { cell: undefined, kind: 'boolean' }
 * ```
 */
export function cellOf(
	row: Pick<Row, 'meta'>,
	key: string,
	addedKinds: ReadonlyMap<string, FieldKind>,
): { cell: Cell | undefined; kind: FieldKind } {
	const cell = Object.hasOwn(row.meta, key) ? row.meta[key] : undefined;
	return {
		cell,
		kind: cell === undefined ? (addedKinds.get(key) ?? 'text') : kindOf(cell.value),
	};
}

/**
 * The cell of a key in a row, and the kind of input that edits it, for a column that may have
 * been given a kind: an enum column is edited by choosing, whatever the value is, unless the
 * value is one no choice can make (an object, an array that holds one), which stays JSON.
 * @param row - The row
 * @param key - The key
 * @param hints - The kinds chosen for keys added on the screen, and those inferred (see
 * {@link inferredKinds}), for a page that does not have the key
 * @param enumKind - The kind the column was given, if it is an enum
 * @example
 * ```ts
 * editKindOf({ meta: {} }, 'layout', new Map(), { type: 'enum', options: ['wide'] });
 * // { cell: undefined, kind: 'enum' }
 * ```
 */
export function editKindOf(
	row: Pick<Row, 'meta'>,
	key: string,
	hints: ReadonlyMap<string, FieldKind>,
	enumKind?: EnumKind,
): { cell: Cell | undefined; kind: FieldKind } {
	const { cell, kind } = cellOf(row, key, hints);
	return { cell, kind: enumKind !== undefined && kind !== 'json' ? 'enum' : kind };
}

/**
 * The kinds of the keys of a window of rows, for a page that has no value to say it: a key that
 * every page that has a value for holds a boolean is a boolean, so that a page without it shows
 * an empty checkbox, and checking it writes `true`. A key that was added on the screen keeps the
 * kind it was added as. `null` is no value here. This is read from the rows on the screen
 * only: it never makes the screen read more.
 * @param rows - The rows on the screen
 * @param keys - The keys of the columns
 * @param given - The kinds chosen for keys added on the screen (not changed)
 * @example
 * ```ts
 * inferredKinds(rows, ['draft'], new Map()); // Map { 'draft' => 'boolean' }, when every value is one
 * ```
 */
export function inferredKinds(
	rows: readonly Pick<Row, 'meta'>[],
	keys: readonly string[],
	given: ReadonlyMap<string, FieldKind>,
): Map<string, FieldKind> {
	const kinds = new Map(given);
	for (const key of keys) {
		if (kinds.has(key)) {
			continue;
		}
		let booleans = 0;
		let other = false;
		for (const row of rows) {
			if (!Object.hasOwn(row.meta, key)) {
				continue;
			}
			const value = row.meta[key]?.value;
			if (value === null || value === undefined) {
				continue;
			}
			if (typeof value === 'boolean') {
				booleans += 1;
			} else {
				other = true;
				break;
			}
		}
		if (!other && booleans > 0) {
			kinds.set(key, 'boolean');
		}
	}
	return kinds;
}

/**
 * Whether two maps of kinds hold the same kind for the same keys. The rows are drawn from a map
 * of kinds, and a row is not drawn again while it is given the same map: a map made again after
 * each read is kept as the one before when nothing in it changed.
 * @param a - A map
 * @param b - Another
 * @example
 * ```ts
 * sameKinds(new Map([['a', 'boolean']]), new Map([['a', 'boolean']])); // true
 * ```
 */
export function sameKinds(
	a: ReadonlyMap<string, FieldKind>,
	b: ReadonlyMap<string, FieldKind>,
): boolean {
	return a.size === b.size && [...a].every(([key, kind]) => b.get(key) === kind);
}

/**
 * Whether a page of the rows holds an array under a key: a page that has no value there is then
 * chosen for as the others are, with several choices.
 * @param rows - The rows on the screen
 * @param key - The key
 * @example
 * ```ts
 * columnHoldsArrays(rows, 'tags'); // true when a row has an array in `tags`
 * ```
 */
export function columnHoldsArrays(
	rows: readonly Pick<Row, 'meta'>[],
	key: string,
): boolean {
	return rows.some(
		(row) => Object.hasOwn(row.meta, key) && Array.isArray(row.meta[key]?.value),
	);
}
