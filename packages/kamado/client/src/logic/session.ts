/**
 * What the screen decides, apart from drawing it: whether an edit may be sent, what happens
 * to the list when an edit is answered, where the focus goes when the list is read again, and
 * whether a cell that was left is to be written. They are functions of plain values so that
 * they can be tested without a browser; `app.tsx` only calls them.
 */
import type { Translate } from '../i18n/translate.js';
import type { Edited, Row, Rows } from '../types.js';

import { english } from '../i18n/translate.js';

import { clampPage } from './grid.js';
import { sameValue } from './value.js';

/**
 * Whether the list on the screen is the one the next edit can be made on: `busy` while it
 * is being read (the hashes it holds may be those of before), `ok` when it is shown, and
 * `failed` when it could not be read (it stays until it is read again).
 */
export type Reading = 'busy' | 'failed' | 'ok';

/**
 * Why an edit cannot be sent now, or `null` when it can. Said to the user, since an edit that
 * is dropped must not look as if it was written.
 * @param reading - The state of the list
 * @param t - Says the reason in the language of the screen (English by default)
 * @example
 * ```ts
 * editBlockedReason('ok'); // null
 * editBlockedReason('busy'); // 'The list is being read again: ...'
 * ```
 */
export function editBlockedReason(
	reading: Reading,
	t: Translate = english,
): string | null {
	switch (reading) {
		case 'busy': {
			return t('session.busy');
		}
		case 'failed': {
			return t('session.failed');
		}
		default: {
			return null;
		}
	}
}

/**
 * The row of a page, by its URL. A page is named by its URL and not by its place in the list
 * because the list can be read again, and ordered differently, between an edit being asked
 * for and being made.
 * @param rows - The list, if there is one
 * @param url - The URL
 * @example
 * ```ts
 * rowByUrl(rows, '/about/')?.url; // '/about/'
 * ```
 */
export function rowByUrl(rows: Rows | null, url: string): Row | undefined {
	return rows?.pages.find((page) => page.url === url);
}

/**
 * The list after an edit was made: the page as the files hold it now, and the version and the
 * hash of `pages.overrides` that the answer says (every row sends that hash, and the edit
 * changed it).
 * @param rows - The list the edit was made on
 * @param url - The URL of the page that was edited (before a move)
 * @param edited - The answer of the server
 */
export function applyEdited(
	rows: Rows,
	url: string,
	edited: Pick<Edited, 'overridesHash' | 'page' | 'version'>,
): Rows {
	return {
		...rows,
		version: edited.version,
		overridesHash: edited.overridesHash,
		pages: rows.pages.map((page) => (page.url === url ? edited.page : page)),
	};
}

/**
 * Where the focus goes when the list has been read: on the page that was moved, when it is
 * on this page of the list (and a line saying where it went when it is not), otherwise where
 * it was, held to the rows there are now.
 * @param urls - The URLs of the rows shown, in order
 * @param was - Where the focus was
 * @param moved - The URL a page was moved to, if the reading follows a move
 * @param t - Says what was done in the language of the screen (English by default)
 * @returns The row, and what to say about a move (`null` when there was none)
 * @example
 * ```ts
 * focusAfterLoad(['/a/', '/b/'], 0, '/b/'); // { row: 1, said: 'Moved to /b/' }
 * ```
 */
export function focusAfterLoad(
	urls: readonly string[],
	was: number,
	moved: string | null,
	t: Translate = english,
): { row: number; said: string | null } {
	const stay = Math.min(was, Math.max(0, urls.length - 1));
	if (moved === null) {
		return { row: stay, said: null };
	}
	const at = urls.indexOf(moved);
	return at === -1
		? { row: stay, said: t('app.movedElsewhere', { url: moved }) }
		: { row: at, said: t('app.moved', { url: moved }) };
}

/**
 * The page to ask for instead, when the one that was asked for has no rows although the list
 * has some (an edit, or the files, took rows away from the end), or `null` when it is fine.
 * @param page - The page that was read, from 0
 * @param shown - Rows it came with
 * @param total - Rows in all
 * @param size - Rows a page shows
 * @example
 * ```ts
 * pageToReadInstead(3, 0, 1001, 500); // 2
 * pageToReadInstead(0, 0, 0, 500); // null
 * ```
 */
export function pageToReadInstead(
	page: number,
	shown: number,
	total: number,
	size: number,
): number | null {
	return page > 0 && shown === 0 && total > 0 ? clampPage(page, total, size) : null;
}

/**
 * Whether a cell that was left is to be written. Not when it was opened and left as it was
 * (its text is what the value was shown as, and writing that back could still change the
 * value: a date with a time is shown as its day, `null` as an empty text), nor when the value
 * is the one it was, nor when a key the page does not have is given nothing.
 *
 * A key the page does not have is different: its cell opens with the default of the kind the
 * key was added as (`0`, `[]`, today), and writing that is the act of giving the page the
 * key (as adding a key does in BurgerEditor). Only an empty text, which is no value for a
 * key, is not written.
 * @param cell - What the page has for the key (`value`), or `null` when it has none
 * @param draft - The text that was typed
 * @param opened - The text the cell was opened with
 * @param value - What the text is as a value
 * @example
 * ```ts
 * shouldWrite({ value: 'A' }, 'B', 'A', 'B'); // true
 * shouldWrite({ value: '2026-01-02T03:04:05' }, '2026-01-02', '2026-01-02', '2026-01-02'); // false
 * shouldWrite(null, '', '', ''); // false
 * ```
 */
export function shouldWrite(
	cell: { readonly value: unknown } | null,
	draft: string,
	opened: string,
	value: unknown,
): boolean {
	if (cell === null) {
		return draft !== '' && value !== null;
	}
	return draft !== opened && !sameValue(cell.value, value);
}

/** Runs tasks one after another, so that each is made on what the one before left. */
export interface Queue {
	/**
	 * Puts a task at the end. It starts when every task before it has ended, and a task that
	 * throws does not stop the ones after it.
	 * @param task - What to run
	 */
	readonly enqueue: (task: () => Promise<void>) => void;
	/** Resolves when every task put so far has ended. */
	readonly idle: () => Promise<void>;
}

/**
 * Makes a {@link Queue}.
 * @example
 * ```ts
 * const queue = createQueue();
 * queue.enqueue(async () => {});
 * await queue.idle();
 * ```
 */
export function createQueue(): Queue {
	let tail: Promise<void> = Promise.resolve();
	return {
		enqueue(task) {
			tail = tail.then(task).catch(() => {});
		},
		idle: () => tail,
	};
}
