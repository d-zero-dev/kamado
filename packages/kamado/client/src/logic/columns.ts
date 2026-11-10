import type { Cell, Row } from '../types.js';
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
