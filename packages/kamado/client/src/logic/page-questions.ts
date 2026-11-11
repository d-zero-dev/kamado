/**
 * What the screen asks before pages or files come and go, and what an answer comes to. The
 * dialog (`page-dialog.tsx`) only draws a question and reports the button that was pressed;
 * which request that is, and whether there is anything to ask at all, is decided here, in
 * functions that are tested without a browser.
 */
import type { Translate } from '../i18n/translate.js';
import type { Expect } from '../types.js';

import { english } from '../i18n/translate.js';

import { saidOfPage } from './page-edits.js';
import { focusAfterLoad } from './session.js';

/**
 * What the dialog asks:
 * - `addVirtual`: the form that adds a page had no path, so the page would be virtual;
 * - `emptyPath`: the `inputPath` of a page was emptied, so its file would go (the page can stay
 *   as a virtual page, or go with it);
 * - `virtualize`: the box of `virtual` was checked on a page that has a file;
 * - `delete`: the `url` of a page was emptied.
 * @example
 * ```ts
 * const question: PageQuestion = { kind: 'addVirtual', url: '/service/' };
 * ```
 */
export type PageQuestion =
	| { readonly kind: 'addVirtual'; readonly url: string }
	| {
			readonly kind: 'delete' | 'emptyPath' | 'virtualize';
			readonly url: string;
			/** The files that would be deleted, as the screen names them; none for a virtual page. */
			readonly files: readonly string[];
			/** Whether the page is virtual (it has no file, and is an entry of `pages.overrides`). */
			readonly virtual: boolean;
			/**
			 * The hashes of the files as they were when the dialog opened: what is removed is what
			 * was shown, and not a file that changed while the question stood.
			 */
			readonly expect: Expect;
	  };

/**
 * The button of the dialog that was pressed (Cancel is no choice).
 * @example
 * ```ts
 * const choice: PageChoice = 'virtualize';
 * ```
 */
export type PageChoice = 'add' | 'delete' | 'virtualize';

/**
 * What an answer to a question comes to: the request to make.
 * @example
 * ```ts
 * const answer: PageAnswer = { kind: 'create', url: '/service/' };
 * ```
 */
export type PageAnswer =
	| { readonly kind: 'create'; readonly url: string }
	| {
			readonly kind: 'delete' | 'virtualize';
			readonly url: string;
			readonly expect: Expect;
	  };

/**
 * The request a pressed button asks for, or `null` when the question does not offer that
 * button (the dialog draws only the buttons of its question, so this is a question and a
 * choice that do not belong together: nothing is done, and above all nothing is deleted).
 * @param question - What was asked
 * @param choice - The button that was pressed
 * @example
 * ```ts
 * answerOf({ kind: 'addVirtual', url: '/v/' }, 'add'); // { kind: 'create', url: '/v/' }
 * answerOf({ kind: 'delete', url: '/a/', files: [], virtual: true, expect }, 'virtualize'); // null
 * ```
 */
export function answerOf(question: PageQuestion, choice: PageChoice): PageAnswer | null {
	if (question.kind === 'addVirtual') {
		return choice === 'add' ? { kind: 'create', url: question.url } : null;
	}
	const offered: readonly PageChoice[] =
		question.kind === 'emptyPath'
			? ['virtualize', 'delete']
			: question.kind === 'virtualize'
				? ['virtualize']
				: ['delete'];
	if (choice === 'add' || !offered.includes(choice)) {
		return null;
	}
	return { kind: choice, url: question.url, expect: question.expect };
}

/**
 * Whether the site can hold a virtual page: it has a `pages.overrides` file, where one is
 * written. Without it, a page is not made virtual and no virtual page is added, and the screen
 * says so instead of asking.
 * @param overridesFile - The `pages.overrides` file as the server names it; `null` or absent
 * when the site has none
 * @example
 * ```ts
 * holdsVirtualPages('pages.overrides.json'); // true
 * holdsVirtualPages(null); // false
 * ```
 */
export function holdsVirtualPages(overridesFile: string | null | undefined): boolean {
	return overridesFile !== null && overridesFile !== undefined;
}

/**
 * What is said once the list was read again, when the focus was to go to a page: what was done
 * to the page when that was said (`done`: it was added, made virtual, given a file), and that
 * it was moved when not (its URL or its file was changed). `null` when the focus was to go
 * nowhere.
 * @param urls - The URLs of the rows shown
 * @param wanted - The URL of the page the focus was to go to, or `null`
 * @param done - What was done to it, as a sentence, or `null` for a move
 * @param t - Says the rest in the language of the screen (English by default)
 * @example
 * ```ts
 * saidAfterLoad(['/a/'], '/a/', 'Page /a/ added'); // 'Page /a/ added'
 * saidAfterLoad(['/a/'], '/a/', null); // 'Moved to /a/'
 * saidAfterLoad(['/a/'], null, 'Page /a/ added'); // null
 * ```
 */
export function saidAfterLoad(
	urls: readonly string[],
	wanted: string | null,
	done: string | null,
	t: Translate = english,
): string | null {
	if (wanted === null) {
		return null;
	}
	return done === null
		? focusAfterLoad(urls, 0, wanted, t).said
		: saidOfPage(urls, wanted, done, t);
}
