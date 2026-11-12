/**
 * The key that places a page among its siblings (`order`, RFC section 6), and what the screen
 * does when an edit changes it: the list follows the page to where the plan puts it now.
 */
import type { Change } from '../types.js';
import type { SortState } from './sort.js';

/** The key of the metadata that places a page. */
export const ORDER_KEY = 'order';

/**
 * Whether an edit may have moved the page in the list, and the list is to be read again to
 * follow it: the edit sets or removes `order`, and the rows are in the order of the plan (a
 * sort of another column does not move a row for it).
 * @param change - The edit that was made
 * @param sort - The sort the rows are read in, `null` for the order of the plan
 * @example
 * ```ts
 * movesPage({ op: 'set', key: 'order', value: 3 }, null); // true
 * movesPage({ op: 'set', key: 'order', value: 3 }, { key: 'url', desc: false }); // false
 * movesPage({ op: 'set', key: 'title', value: 'A' }, null); // false
 * ```
 */
export function movesPage(change: Change, sort: SortState | null): boolean {
	return (
		sort === null &&
		(change.op === 'set' || change.op === 'delete') &&
		change.key === ORDER_KEY
	);
}

/**
 * The page of the list to read instead when the core located the page the screen asked for
 * somewhere else than where the screen was reading (the page moved to another window of the
 * list), or `null` when the window the answer holds is the one asked for.
 * @param asked - Where the window the screen asked for starts
 * @param answered - Where the window the core answered with starts
 * @param size - Rows a page of the list shows
 * @example
 * ```ts
 * pageOfLocated(0, 200, 100); // 2
 * pageOfLocated(100, 100, 100); // null
 * ```
 */
export function pageOfLocated(
	asked: number,
	answered: number,
	size: number,
): number | null {
	return answered === asked || size < 1 ? null : Math.floor(answered / size);
}
