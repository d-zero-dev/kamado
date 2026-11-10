/**
 * The order of the rows the screen asks for. The sort is made by the core over every page
 * (RFC section 14.2), so what is kept here is only which column and which way, and how a click on
 * a header moves it.
 */

/** The column the rows are ordered by, and which way; `null` is the order of the plan. */
export interface SortState {
	/** The identifier of the column: `url`, `inputPath`, `virtual` or `meta:<key>`. */
	readonly key: string;
	readonly desc: boolean;
}

/**
 * The identifier of a column, as the server and the settings name it. A key of the metadata is
 * told from a fixed column by `meta:`, so that a key called `url` is not the URL.
 * @param name - The text of the header
 * @param fixed - Whether the column is one of the three fixed ones
 * @example
 * ```ts
 * columnKey('title', false); // 'meta:title'
 * columnKey('url', true); // 'url'
 * ```
 */
export function columnKey(name: string, fixed: boolean): string {
	return fixed ? name : `meta:${name}`;
}

/**
 * The longest identifier the server takes (`MAX_SORT_KEY` of `src/ui/settings.ts`; the screen
 * does not import the server, so the number is written here too). A column with a longer key
 * is shown without a sort: asking for it would only be refused.
 */
export const MAX_SORT_KEY = 256;

/**
 * Whether the server takes the column's identifier as a sort.
 * @param key - The identifier of the column
 * @example
 * ```ts
 * canSort('meta:title'); // true
 * canSort(`meta:${'k'.repeat(300)}`); // false
 * ```
 */
export function canSort(key: string): boolean {
	// `meta:` with no name is what a key that is the empty string makes: the server refuses it.
	return key.length <= MAX_SORT_KEY && key !== 'meta:';
}

/**
 * The sort to go on with after the list could not be read in it. The server's `invalidSort` says the
 * sort itself is refused (one that came from a settings file somebody edited, or a column the
 * server does not take), so it is let go; any other failure (the network, the disk) says nothing
 * about the sort, which is kept.
 * @param current - The sort the read was made with
 * @param code - The `code` of the failure (`ApiError.code`)
 * @example
 * ```ts
 * sortAfterFailure({ key: 'meta:', desc: false }, 'invalidSort'); // null
 * sortAfterFailure({ key: 'url', desc: false }, 'network'); // { key: 'url', desc: false }
 * ```
 */
export function sortAfterFailure(
	current: SortState | null,
	code: string,
): SortState | null {
	return code === 'invalidSort' ? null : current;
}

/**
 * What a click on the header of a column does: ascending, then descending, then no sort. A
 * column that is not the sorted one starts ascending.
 * @param current - The sort now
 * @param key - The identifier of the clicked column
 * @example
 * ```ts
 * nextSort(null, 'url'); // { key: 'url', desc: false }
 * nextSort({ key: 'url', desc: true }, 'url'); // null
 * ```
 */
export function nextSort(current: SortState | null, key: string): SortState | null {
	if (current === null || current.key !== key) {
		return { key, desc: false };
	}
	return current.desc ? null : { key, desc: true };
}

/**
 * Whether two sorts are the same.
 * @param a - A sort
 * @param b - Another
 * @example
 * ```ts
 * sameSort({ key: 'url', desc: false }, { key: 'url', desc: false }); // true
 * sameSort(null, { key: 'url', desc: false }); // false
 * ```
 */
export function sameSort(a: SortState | null, b: SortState | null): boolean {
	if (a === null || b === null) {
		return a === b;
	}
	return a.key === b.key && a.desc === b.desc;
}

/**
 * The `aria-sort` of a column header.
 * @param current - The sort now
 * @param key - The identifier of the column
 * @example
 * ```ts
 * ariaSortOf({ key: 'url', desc: false }, 'url'); // 'ascending'
 * ```
 */
export function ariaSortOf(
	current: SortState | null,
	key: string,
): 'ascending' | 'descending' | 'none' {
	if (current === null || current.key !== key) {
		return 'none';
	}
	return current.desc ? 'descending' : 'ascending';
}

/**
 * The parameters of `GET /api/pages` that carry the sort.
 * @param current - The sort now
 * @example
 * ```ts
 * sortParams({ key: 'meta:title', desc: true }); // { sort: 'meta:title', desc: 'true' }
 * sortParams(null); // {}
 * ```
 */
export function sortParams(current: SortState | null): Record<string, string> {
	return current === null ? {} : { sort: current.key, desc: String(current.desc) };
}
