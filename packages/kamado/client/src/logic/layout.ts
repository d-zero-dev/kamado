/**
 * How the columns of the grid are laid out: which are shown in what order, which are pinned to
 * the left edge, and how wide each is. All of it is plain data and pure functions, so that the
 * rules (a pinned column is first, a column moves only among its own group, a width has a
 * range) are tested without a browser; the screen only draws what {@link layoutOf} says and
 * calls the functions below when a person acts.
 *
 * A column is named by its identifier, as the server and the settings name it: `url`,
 * `virtual`, `inputPath`, `order`, `outputPath`, `parent`, `depth`, or `meta:<key>` (a key
 * called `url` is not the URL).
 */
import type { Translate } from '../i18n/translate.js';

import { metaColumns } from './columns.js';
import { canSort, columnKey } from './sort.js';

/**
 * The narrowest and the widest a column is made, in pixels, and the most columns a list names.
 * The server checks the same numbers (`src/ui/settings.ts`); the screen cannot import that module
 * (another `tsconfig`, another runtime), so they are written again, and
 * `settings-columns.spec.ts` compares the two.
 */
export const MIN_COLUMN_WIDTH = 48;
export const MAX_COLUMN_WIDTH = 2000;

export const MAX_COLUMNS = 500;

/**
 * The most bytes the three lists of the settings take when they are sent. A key may be 256
 * characters, so the count of columns alone does not keep the layout inside the 64 KiB a change of
 * the settings may be (`MAX_SETTINGS_BODY` of `src/ui/app.ts`): this leaves the rest of the change
 * (the page size, the sort, the language) room, and {@link settingsOf} drops the columns at the end
 * of a list until the layout fits.
 */
export const MAX_COLUMNS_BYTES = 48 * 1024;

/** The columns that are pinned until the person changes it. */
export const DEFAULT_PINNED: readonly string[] = ['url'];

/**
 * The columns before the keys of the metadata, which every row has: what a page is (its URL,
 * whether it is virtual, its file) and what the plan makes of it (its place in the plan, the
 * file it is written to, the page above it, how deep it is). The last four are read only.
 */
const BUILTIN: readonly string[] = [
	'url',
	'virtual',
	'inputPath',
	'order',
	'outputPath',
	'parent',
	'depth',
];

/**
 * The widths a column has until it is changed, in pixels and not in rem: the places the pinned
 * columns stick at are the sums of the widths before them, and a sum in rem would move with the
 * font size of the browser while the column's own text did not.
 */
const BUILTIN_WIDTHS: Readonly<Record<string, number>> = {
	url: 448,
	virtual: 96,
	inputPath: 384,
	// As wide as `virtual`: a number of a few digits needs less, the name in the header does not.
	order: 96,
	outputPath: 384,
	parent: 320,
	depth: 96,
};
const META_WIDTH = 224;

/**
 * What the screen holds of the layout. `order` and `pinned` are `undefined` when the person has
 * not set them: the layout is then the one the config gives (`defaultOrder` and `defaultPinned`),
 * and when the config gives none either, the default order and the URL pinned.
 */
export interface ColumnState {
	readonly order: readonly string[] | undefined;
	readonly pinned: readonly string[] | undefined;
	/** Widths in pixels of the columns that are not the default width. */
	readonly widths: Readonly<Record<string, number>>;
	/** `ui.defaultKeyOrder` of the config, as written; left out when the config has none. */
	readonly defaultOrder?: readonly string[];
	/** `ui.defaultFixedKeys` of the config, as written; left out when the config has none. */
	readonly defaultPinned?: readonly string[];
}

/**
 * The layout the config gives the screen until a person sets one (`ui.defaultKeyOrder` and
 * `ui.defaultFixedKeys`). A field is left out when the config does not write it. The server
 * writes the same shape into the page (`ColumnDefaults` of `src/ui/app.ts`).
 */
export interface ColumnDefaults {
	readonly order?: readonly string[];
	readonly pinned?: readonly string[];
}

/** The layout as the settings keep it (`columns` of the project settings). */
export interface ColumnSettings {
	readonly order?: readonly string[];
	readonly pinned?: readonly string[];
	readonly widths?: Readonly<Record<string, number>>;
}

/** What is drawn: the columns in their places, and the numbers the pinned ones stick by. */
export interface Layout {
	/** The identifiers, left to right: the pinned columns, then the rest. */
	readonly shown: readonly string[];
	/** How many of the first columns are pinned. */
	readonly pinnedCount: number;
	/** The width in pixels of each of `shown`. */
	readonly widths: readonly number[];
	/** The distance from the left edge of each pinned column (of the first `pinnedCount`). */
	readonly lefts: readonly number[];
}

/**
 * The layout of a person who has set nothing.
 * @example
 * ```ts
 * emptyLayout(); // { order: undefined, pinned: undefined, widths: {} }
 * ```
 */
export function emptyLayout(): ColumnState {
	return { order: undefined, pinned: undefined, widths: {} };
}

/**
 * The state the settings describe. What the settings do not set, field by field, is what the
 * config gives; what the config does not give either is the default of the screen.
 * @param settings - `columns` of the project settings, if it has any
 * @param defaults - The layout the config gives, if it gives any
 * @example
 * ```ts
 * stateOf({ pinned: [] }); // { order: undefined, pinned: [], widths: {} }
 * stateOf(undefined, { pinned: ['url', 'meta:title'] }).defaultPinned; // ['url', 'meta:title']
 * ```
 */
export function stateOf(
	settings?: ColumnSettings,
	defaults?: ColumnDefaults,
): ColumnState {
	return {
		order: settings?.order,
		pinned: settings?.pinned,
		widths: settings?.widths ?? {},
		...(defaults?.order === undefined ? {} : { defaultOrder: defaults.order }),
		...(defaults?.pinned === undefined ? {} : { defaultPinned: defaults.pinned }),
	};
}

/**
 * The pinned columns the layout holds now, before the columns there are are looked at: what the
 * person set, or else what the config gives.
 * @param state - The state
 */
function heldPinned(state: ColumnState): readonly string[] | undefined {
	return state.pinned ?? state.defaultPinned;
}

/**
 * The order the layout holds now, before the columns there are are looked at: what the person
 * set, or else what the config gives.
 * @param state - The state
 */
function heldOrder(state: ColumnState): readonly string[] | undefined {
	return state.order ?? state.defaultOrder;
}

/**
 * The identifiers of all the columns, in the default order: the fixed columns, then the keys in
 * the order of their names.
 * @param keys - The keys of the metadata (the pages' and those added on the screen)
 * @example
 * ```ts
 * columnIds(['b', 'a']);
 * // ['url', 'virtual', 'inputPath', 'order', 'outputPath', 'parent', 'depth', 'meta:a', 'meta:b']
 * ```
 */
export function columnIds(keys: readonly string[]): string[] {
	return [...BUILTIN, ...metaColumns(keys, []).map((key) => columnKey(key, false))];
}

/**
 * The text of a column's header: a fixed column by its name, a key by the key.
 * @param id - The identifier of the column
 * @example
 * ```ts
 * columnName('meta:title'); // 'title'
 * columnName('url'); // 'url'
 * ```
 */
export function columnName(id: string): string {
	return id.startsWith('meta:') ? id.slice('meta:'.length) : id;
}

/**
 * Whether a column of metadata has the name of a fixed column (a key called `url`, `virtual`,
 * `inputPath`, `order`, `outputPath`, `parent` or `depth`), so that the two cannot be told
 * apart by their names.
 * @param id - The identifier of the column
 * @example
 * ```ts
 * clashesWithFixedColumn('meta:url'); // true
 * clashesWithFixedColumn('meta:title'); // false
 * ```
 */
export function clashesWithFixedColumn(id: string): boolean {
	return id.startsWith('meta:') && BUILTIN.includes(columnName(id));
}

/**
 * The name the screen shows for a column (the header, the menu, what is said of it): the
 * key for a column of metadata, with a mark when a fixed column has the same name. What is
 * written is still the key: this is for the eyes and the ears only.
 * @param id - The identifier of the column
 * @param t - Says the mark in the language of the screen
 * @example
 * ```ts
 * columnLabel('meta:url', english); // 'url (meta)'
 * columnLabel('url', english); // 'url'
 * ```
 */
export function columnLabel(id: string, t: Translate): string {
	const name = columnName(id);
	return clashesWithFixedColumn(id) ? t('column.metaName', { name }) : name;
}

/**
 * How wide a column is when the person has not changed it, in pixels.
 * @param id - The identifier of the column
 * @example
 * ```ts
 * defaultWidth('url'); // 448
 * ```
 */
export function defaultWidth(id: string): number {
	return Object.hasOwn(BUILTIN_WIDTHS, id)
		? (BUILTIN_WIDTHS[id] ?? META_WIDTH)
		: META_WIDTH;
}

/**
 * Holds a width to the range the server takes, as a whole number.
 * @param width - A width in pixels
 */
function clampWidth(width: number): number {
	return Math.min(Math.max(Math.round(width), MIN_COLUMN_WIDTH), MAX_COLUMN_WIDTH);
}

/**
 * The first of each identifier in a list that is one of `known`.
 * @param list - Identifiers, possibly repeated or no longer there
 * @param known - The columns there are
 */
function existing(list: readonly string[], known: ReadonlySet<string>): string[] {
	return [...new Set(list)].filter((id) => known.has(id));
}

/**
 * The columns that are pinned, in the order they were pinned: the config's when the person has
 * pinned none yet, and the URL when the config gives none either, and only those that are there.
 * @param state - The state
 * @param known - The columns there are
 */
function pinnedOf(state: ColumnState, known: readonly string[]): string[] {
	return existing(heldPinned(state) ?? DEFAULT_PINNED, new Set(known));
}

/**
 * Every column in the order of the person's choice: the order they set, then the columns it does
 * not name (new keys, or all of them when none was set) in the default order. Pinned columns are
 * in it too, at the place they come back to when they are unpinned.
 * @param state - The state
 * @param known - The columns there are, in the default order
 */
function fullOrder(state: ColumnState, known: readonly string[]): string[] {
	const named = existing(heldOrder(state) ?? [], new Set(known));
	const seen = new Set(named);
	return [...named, ...known.filter((id) => !seen.has(id))];
}

/**
 * The columns that are not pinned, in order.
 * @param state - The state
 * @param known - The columns there are, in the default order
 */
function unpinnedOf(state: ColumnState, known: readonly string[]): string[] {
	const pinned = new Set(pinnedOf(state, known));
	return fullOrder(state, known).filter((id) => !pinned.has(id));
}

/**
 * What to draw: the columns in their places, their widths, and where the pinned ones stick.
 * @param known - The columns there are, in the default order ({@link columnIds})
 * @param state - What the person set
 * @example
 * ```ts
 * layoutOf(columnIds(['a']), emptyLayout()).pinnedCount; // 1 (the URL)
 * ```
 */
export function layoutOf(known: readonly string[], state: ColumnState): Layout {
	const pinned = pinnedOf(state, known);
	const shown = [...pinned, ...unpinnedOf(state, known)];
	const widths = shown.map((id) => {
		const own = Object.hasOwn(state.widths, id) ? state.widths[id] : undefined;
		return own === undefined ? defaultWidth(id) : clampWidth(own);
	});
	const lefts: number[] = [];
	let left = 0;
	for (let i = 0; i < pinned.length; i++) {
		lefts.push(left);
		left += widths[i] ?? 0;
	}
	return { shown, pinnedCount: pinned.length, widths, lefts };
}

/**
 * Where a column is among those shown.
 * @param layout - The layout
 * @param id - The identifier of the column
 * @returns Its place from 0, or -1 when it is not shown
 * @example
 * ```ts
 * positionOf(layoutOf(columnIds([]), emptyLayout()), 'inputPath'); // 2
 * ```
 */
export function positionOf(layout: Layout, id: string): number {
	return layout.shown.indexOf(id);
}

/**
 * Whether a key opens the menu of the column the focus is in: `Alt+↓`, the menu key of the
 * keyboard, and `Shift+F10` (what the menu key is on a keyboard that has none).
 * @param key - `KeyboardEvent.key`
 * @param alt - Whether Alt is down
 * @param shift - Whether Shift is down
 * @example
 * ```ts
 * opensMenu('ArrowDown', true, false); // true
 * opensMenu('ArrowDown', false, false); // false
 * ```
 */
export function opensMenu(key: string, alt: boolean, shift: boolean): boolean {
	return (
		(alt && key === 'ArrowDown') || key === 'ContextMenu' || (shift && key === 'F10')
	);
}

/**
 * The columns a list names that are not among the columns there now. The layout of a column that
 * is not there (a key no page has at the moment) is carried through every change, so that it is
 * found again if the key comes back.
 * @param list - `order` or `pinned` of the state
 * @param known - The columns there are
 */
function absent(list: readonly string[] | undefined, known: readonly string[]): string[] {
	const there = new Set(known);
	return (list ?? []).filter((id) => !there.has(id));
}

/**
 * Pins a column after the ones that are pinned (a column that is pinned stays where it is).
 * @param state - The state
 * @param known - The columns there are
 * @param id - The column to pin
 * @example
 * ```ts
 * pinColumn(emptyLayout(), columnIds(['a']), 'meta:a').pinned; // ['url', 'meta:a']
 * ```
 */
export function pinColumn(
	state: ColumnState,
	known: readonly string[],
	id: string,
): ColumnState {
	const pinned = pinnedOf(state, known);
	if (pinned.includes(id) || !known.includes(id)) {
		return state;
	}
	return { ...state, pinned: [...pinned, id, ...absent(heldPinned(state), known)] };
}

/**
 * Unpins a column: it goes back to its place among the others.
 * @param state - The state
 * @param known - The columns there are
 * @param id - The column to unpin
 * @example
 * ```ts
 * unpinColumn(emptyLayout(), columnIds([]), 'url').pinned; // []
 * ```
 */
export function unpinColumn(
	state: ColumnState,
	known: readonly string[],
	id: string,
): ColumnState {
	const pinned = pinnedOf(state, known);
	if (!pinned.includes(id)) {
		return state;
	}
	return {
		...state,
		pinned: [...pinned.filter((p) => p !== id), ...absent(heldPinned(state), known)],
	};
}

/**
 * The state with the columns of a group put in a new order. For the pinned group that is the
 * order they were pinned in; for the others the places the group's columns have among all the
 * columns are given to them in the new order, and every pinned column keeps its own place, so
 * that unpinning it puts it back where it was.
 * @param state - The state
 * @param known - The columns there are
 * @param group - Which group is reordered
 * @param next - The group's columns in the new order
 */
function withGroup(
	state: ColumnState,
	known: readonly string[],
	group: 'pinned' | 'unpinned',
	next: readonly string[],
): ColumnState {
	if (group === 'pinned') {
		return { ...state, pinned: [...next, ...absent(heldPinned(state), known)] };
	}
	const taken = new Set(pinnedOf(state, known));
	const queue = [...next];
	const order = fullOrder(state, known).map((id) =>
		taken.has(id) ? id : (queue.shift() ?? id),
	);
	return { ...state, order: [...order, ...absent(heldOrder(state), known)] };
}

/**
 * Which group a column is in and the columns of the group in order.
 * @param state - The state
 * @param known - The columns there are
 * @param id - The column
 */
function groupOf(
	state: ColumnState,
	known: readonly string[],
	id: string,
): { group: 'pinned' | 'unpinned'; list: string[] } | undefined {
	const pinned = pinnedOf(state, known);
	if (pinned.includes(id)) {
		return { group: 'pinned', list: pinned };
	}
	const unpinned = unpinnedOf(state, known);
	return unpinned.includes(id) ? { group: 'unpinned', list: unpinned } : undefined;
}

/**
 * Moves a column to the place another column of its group has (the columns between move over
 * by one).
 * @param state - The state
 * @param known - The columns there are
 * @param id - The column to move
 * @param to - The column whose place it takes
 * @example
 * ```ts
 * const known = columnIds(['a', 'b']);
 * moveColumnTo(emptyLayout(), known, 'meta:b', 'virtual');
 * // shows: url, meta:b, virtual, inputPath, meta:a
 * ```
 */
export function moveColumnTo(
	state: ColumnState,
	known: readonly string[],
	id: string,
	to: string,
): ColumnState {
	const from = groupOf(state, known, id);
	const target = groupOf(state, known, to);
	if (
		from === undefined ||
		target === undefined ||
		from.group !== target.group ||
		id === to
	) {
		return state;
	}
	const list = from.list.filter((c) => c !== id);
	list.splice(from.list.indexOf(to), 0, id);
	return withGroup(state, known, from.group, list);
}

/**
 * Moves a column one place left or right among the columns of its group (a pinned column among
 * the pinned ones, the others among the rest).
 * @param state - The state
 * @param known - The columns there are
 * @param id - The column to move
 * @param delta - `-1` for left, `1` for right
 * @example
 * ```ts
 * moveColumn(emptyLayout(), columnIds([]), 'virtual', 1);
 * // shows: url, inputPath, virtual
 * ```
 */
export function moveColumn(
	state: ColumnState,
	known: readonly string[],
	id: string,
	delta: -1 | 1,
): ColumnState {
	const from = groupOf(state, known, id);
	const neighbour = from?.list[from.list.indexOf(id) + delta];
	return from === undefined || neighbour === undefined
		? state
		: moveColumnTo(state, known, id, neighbour);
}

/**
 * Sets the width of a column, held to the range. A width that is the default is not kept.
 * @param state - The state
 * @param id - The column
 * @param width - The width in pixels
 * @example
 * ```ts
 * resizeColumn(emptyLayout(), 'meta:a', 300).widths; // { 'meta:a': 300 }
 * ```
 */
export function resizeColumn(state: ColumnState, id: string, width: number): ColumnState {
	if (!Number.isFinite(width)) {
		return state;
	}
	const clamped = clampWidth(width);
	return clamped === defaultWidth(id)
		? resetWidth(state, id)
		: { ...state, widths: { ...state.widths, [id]: clamped } };
}

/**
 * Puts a column back to its default width.
 * @param state - The state
 * @param id - The column
 * @example
 * ```ts
 * resetWidth(resizeColumn(emptyLayout(), 'url', 300), 'url').widths; // {}
 * ```
 */
export function resetWidth(state: ColumnState, id: string): ColumnState {
	if (!Object.hasOwn(state.widths, id)) {
		return state;
	}
	return {
		...state,
		widths: Object.fromEntries(
			Object.entries(state.widths).filter(([key]) => key !== id),
		),
	};
}

/**
 * The layout as the settings keep it: all three lists, whole, for the columns that are there.
 * The server replaces the layout as a whole, so a change is always sent with all of it.
 * @param state - The state
 * @param known - The columns there are
 * @example
 * ```ts
 * settingsOf(emptyLayout(), columnIds([])).pinned; // ['url']
 * ```
 */
export function settingsOf(state: ColumnState, known: readonly string[]): ColumnSettings {
	const there = new Set(known);
	// What the settings already hold about a column that is not there now (a key that no page has
	// at the moment) is kept after the columns that are, so that it is found again if the key comes
	// back. A column the server would refuse (`canSort`: an empty key, or one that is too long) is
	// left out, or the whole layout would be refused.
	const list = (
		shown: readonly string[],
		held: readonly string[] | undefined,
	): string[] =>
		[...new Set([...shown, ...(held ?? []).filter((id) => !there.has(id))])]
			.filter((id) => canSort(id))
			.slice(0, MAX_COLUMNS);
	return fitSettings({
		// The order is saved once the person has set one: a layout that only pins a column does not
		// fix the order the columns are in now, and the keys that come later still find their place
		// in the default order.
		...(state.order === undefined
			? {}
			: { order: list(fullOrder(state, known), heldOrder(state)) }),
		pinned: list(pinnedOf(state, known), heldPinned(state)),
		widths: Object.fromEntries(
			Object.entries(state.widths)
				.filter(([id]) => canSort(id))
				.slice(0, MAX_COLUMNS),
		),
	});
}

/**
 * The settings cut to {@link MAX_COLUMNS_BYTES}: the columns at the end of the longest list are
 * dropped until they fit (a site whose keys are all very long; a layout of ordinary keys is
 * never cut).
 * @param settings - The settings
 */
function fitSettings(settings: ColumnSettings): ColumnSettings {
	const order = [...(settings.order ?? [])];
	const pinned = [...(settings.pinned ?? [])];
	const widths = Object.entries(settings.widths ?? {});
	const build = (): ColumnSettings => ({
		...(settings.order === undefined ? {} : { order }),
		pinned,
		widths: Object.fromEntries(widths),
	});
	const bytes = () => new TextEncoder().encode(JSON.stringify(build())).length;
	while (bytes() > MAX_COLUMNS_BYTES) {
		let longest: unknown[] = order;
		for (const list of [pinned, widths]) {
			if (list.length > longest.length) {
				longest = list;
			}
		}
		if (longest.length === 0) {
			break;
		}
		longest.splice(-Math.ceil(longest.length / 10));
	}
	return build();
}

/**
 * The width of a column as it is drawn.
 * @param layout - The layout
 * @param id - The identifier of the column
 * @returns The width in pixels, or 0 when the column is not shown
 * @example
 * ```ts
 * widthOf(layoutOf(columnIds([]), emptyLayout()), 'url'); // 448
 * ```
 */
export function widthOf(layout: Layout, id: string): number {
	return layout.widths[positionOf(layout, id)] ?? 0;
}
