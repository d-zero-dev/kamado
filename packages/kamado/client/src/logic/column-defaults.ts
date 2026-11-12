/**
 * The layout of the columns the config gives (`ui.defaultKeyOrder` and `ui.defaultFixedKeys`), and
 * what "back to the defaults" puts back (RFC section 14.2). Both are plain data and pure
 * functions, so that they are tested without a browser.
 */
import type { SettingsPatch } from '../types.js';
import type { KindsSettings } from './kinds.js';
import type { ColumnDefaults, ColumnState } from './layout.js';

import { stateOf } from './layout.js';

/**
 * The rows a screen shows until the person chooses another number (`pageSize` of the settings).
 * The server holds the same number (`DEFAULT_PAGE_SIZE` of `src/ui/settings.ts`; the screen cannot
 * import that module), so a change is made in both.
 */
export const DEFAULT_PAGE_SIZE = 500;

/**
 * The texts of a list, or `undefined` when it is not a list. What is not a text is left out: the
 * server only sends texts, and a page that was changed by hand must not stop the screen.
 * @param value - What the page holds under `order` or `pinned`
 */
function listOf(value: unknown): string[] | undefined {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === 'string')
		: undefined;
}

/**
 * Reads the defaults the server put in the page: `{ "order"?, "pinned"? }` as JSON. Whatever is
 * not that (the page as it is before the server serves it, an empty attribute, a value of
 * another shape) gives no defaults, so the screen lays the columns out by its own defaults (the
 * fixed columns, then the keys by name, with the URL pinned).
 * @param text - The content of the attribute of the page
 * @example
 * ```ts
 * parseColumnDefaults('{"pinned":["url","meta:title"]}'); // { pinned: ['url', 'meta:title'] }
 * parseColumnDefaults('__KAMADO_COLUMN_DEFAULTS__'); // {}
 * ```
 */
export function parseColumnDefaults(text?: string): ColumnDefaults {
	let value: unknown;
	try {
		value = JSON.parse(text ?? '');
	} catch {
		return {};
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return {};
	}
	const record = value as Record<string, unknown>;
	const order = listOf(record.order);
	const pinned = listOf(record.pinned);
	return {
		...(order === undefined ? {} : { order }),
		...(pinned === undefined ? {} : { pinned }),
	};
}

/**
 * What "back to the defaults" leaves on the screen, and what it saves. The screen sets what is in
 * `columnState`, `kinds`, `pageSize` and `sort`, and sends `patch`: the two always say the same
 * four things (the layout of the columns, the order of the rows, the kinds of the columns, the rows
 * per page), which is why they are made together.
 */
export interface Reset {
	/** The layout a person who has set nothing sees: the config's defaults, if it has any. */
	readonly columnState: ColumnState;
	readonly kinds: KindsSettings;
	readonly pageSize: number;
	/** The rows are in the order of the plan. */
	readonly sort: null;
	/** What is saved ({@link resetPatch}). */
	readonly patch: SettingsPatch;
}

/**
 * Puts everything this project keeps back to the defaults.
 * @param defaults - The layout the config gives, if it gives any
 * @example
 * ```ts
 * resetOf({ pinned: ['url', 'meta:title'] }).columnState.defaultPinned; // ['url', 'meta:title']
 * resetOf().pageSize; // 500
 * ```
 */
export function resetOf(defaults?: ColumnDefaults): Reset {
	return {
		columnState: stateOf(undefined, defaults),
		kinds: {},
		pageSize: DEFAULT_PAGE_SIZE,
		sort: null,
		patch: resetPatch(),
	};
}

/**
 * The change of the settings that puts back everything this project keeps: the layout of the
 * columns, the order of the rows, the kinds of the columns and the rows per page. The language is
 * not here: it belongs to every project.
 * @example
 * ```ts
 * resetPatch().project?.columns; // null
 * ```
 */
export function resetPatch(): SettingsPatch {
	return {
		project: { columns: null, sort: null, kinds: null, pageSize: DEFAULT_PAGE_SIZE },
	};
}
