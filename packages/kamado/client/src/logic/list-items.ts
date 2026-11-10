/**
 * The items of a list as the editor of a list holds them while it is open: each is the text of
 * its input and the kind of the input (text, number or boolean), so that what is half typed
 * (`1e`, an empty number) stays as typed and is not turned into a value until the list is
 * written. None of it touches the DOM, so that it is shown by tests.
 */
import type { EnumOption } from './kinds.js';

/** What an item is: the kind of its input. */
export type ItemKind = 'text' | 'number' | 'boolean';

/** An item of the list being edited. `id` is not a place: it follows the item when it moves. */
export interface Item {
	readonly id: number;
	readonly kind: ItemKind;
	/** What is in the input: the text, the digits of the number, or `true` or `false`. */
	readonly text: string;
}

/**
 * The items of the JSON of a list: an array of text, numbers and booleans. Any other JSON (an
 * array that holds an object or `null`, an object, text that is not JSON) is not a list the
 * editor can show item by item, and gives `null`.
 * @param json - JSON text
 * @example
 * ```ts
 * itemsFromJson('["a",1]')?.map((item) => item.kind); // ['text', 'number']
 * itemsFromJson('[{"a":1}]'); // null
 * ```
 */
export function itemsFromJson(json: string): Item[] | null {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return null;
	}
	if (!Array.isArray(value)) {
		return null;
	}
	const items: Item[] = [];
	for (const [id, item] of (value as unknown[]).entries()) {
		if (typeof item === 'string') {
			items.push({ id, kind: 'text', text: item });
		} else if (typeof item === 'number') {
			items.push({ id, kind: 'number', text: String(item) });
		} else if (typeof item === 'boolean') {
			items.push({ id, kind: 'boolean', text: String(item) });
		} else {
			return null;
		}
	}
	return items;
}

/**
 * The values of the items, or the first item that is not one yet (a number that is not a finite
 * number, a boolean that is neither `true` nor `false`).
 * @param items - The items
 * @example
 * ```ts
 * valuesOf(itemsFromJson('["a",2]') ?? []); // { ok: true, values: ['a', 2] }
 * ```
 */
export function valuesOf(
	items: readonly Item[],
):
	| { readonly ok: true; readonly values: EnumOption[] }
	| { readonly ok: false; readonly index: number } {
	const values: EnumOption[] = [];
	for (const [index, item] of items.entries()) {
		if (item.kind === 'text') {
			values.push(item.text);
		} else if (item.kind === 'number') {
			const trimmed = item.text.trim();
			const value = Number(trimmed);
			if (trimmed === '' || !Number.isFinite(value)) {
				return { ok: false, index };
			}
			values.push(value);
		} else {
			const trimmed = item.text.trim();
			if (trimmed !== 'true' && trimmed !== 'false') {
				return { ok: false, index };
			}
			values.push(trimmed === 'true');
		}
	}
	return { ok: true, values };
}

/**
 * What a new item holds before anything is typed.
 * @param kind - The kind of the item
 */
function startOf(kind: ItemKind): string {
	return kind === 'number' ? '0' : kind === 'boolean' ? 'false' : '';
}

/**
 * The kind a new item is given unless the person chooses another: that of the last item, or text
 * for an empty list.
 * @param items - The items
 * @example
 * ```ts
 * kindToAdd([]); // 'text'
 * ```
 */
export function kindToAdd(items: readonly Item[]): ItemKind {
	return items.at(-1)?.kind ?? 'text';
}

/**
 * The items with a new one at the end.
 * @param items - The items
 * @param kind - The kind of the new item
 * @example
 * ```ts
 * addItem([], 'number'); // [{ id: 0, kind: 'number', text: '0' }]
 * ```
 */
export function addItem(items: readonly Item[], kind: ItemKind): Item[] {
	let id = 0;
	for (const item of items) {
		id = Math.max(id, item.id + 1);
	}
	return [...items, { id, kind, text: startOf(kind) }];
}

/**
 * The items with what is typed in one of them changed.
 * @param items - The items
 * @param id - The item
 * @param text - What is in its input now
 * @example
 * ```ts
 * changeItem([{ id: 0, kind: 'text', text: 'a' }], 0, 'b'); // [{ id: 0, kind: 'text', text: 'b' }]
 * ```
 */
export function changeItem(items: readonly Item[], id: number, text: string): Item[] {
	return items.map((item) => (item.id === id ? { ...item, text } : item));
}

/**
 * The items without one.
 * @param items - The items
 * @param id - The item to take away
 * @example
 * ```ts
 * removeItem([{ id: 0, kind: 'text', text: 'a' }], 0); // []
 * ```
 */
export function removeItem(items: readonly Item[], id: number): Item[] {
	return items.filter((item) => item.id !== id);
}

/**
 * The items with one moved up (`-1`) or down (`1`) by a place; at the end of the list it stays.
 * @param items - The items
 * @param id - The item to move
 * @param by - `-1` for up, `1` for down
 * @example
 * ```ts
 * moveItem(itemsFromJson('["a","b"]') ?? [], 1, -1); // the items in the order b, a
 * ```
 */
export function moveItem(items: readonly Item[], id: number, by: -1 | 1): Item[] {
	const from = items.findIndex((item) => item.id === id);
	const to = from + by;
	if (from < 0 || to < 0 || to >= items.length) {
		return [...items];
	}
	const next = [...items];
	const [moved] = next.splice(from, 1);
	if (moved !== undefined) {
		next.splice(to, 0, moved);
	}
	return next;
}
