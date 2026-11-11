/**
 * The edits that change which pages there are, and whether a page has a file: what a cell of
 * `url`, `inputPath` or `virtual` asks for when it is edited, and what the form that adds a page
 * asks for. All of it is plain data and pure functions; the screen makes the request, or asks
 * the person first when a file or a page would go.
 *
 * Why an empty `inputPath` asks and does not just remove the file: without its file a page is
 * gone, URL and all, and a person editing the map of a site often means to keep the URL and
 * only say that nothing is written there (a virtual page). The two are told apart by asking.
 */
import type { Translate } from '../i18n/translate.js';
import type { Change, Removed, Row, Rows } from '../types.js';

import { english } from '../i18n/translate.js';

import { pathChangeOf } from './move-path.js';

/**
 * What typing into the `inputPath` of a page comes to: nothing, a change to send, or a question
 * to ask the person first (`ask`: the file would go).
 * @example
 * ```ts
 * const edit: PathEdit = { kind: 'move', change: { op: 'movePath', path: 'b/index.html' } };
 * ```
 */
export type PathEdit =
	| { readonly kind: 'none' }
	| { readonly kind: 'ask' }
	| { readonly kind: 'move'; readonly change: Extract<Change, { op: 'movePath' }> }
	| {
			readonly kind: 'materialize';
			readonly change: Extract<Change, { op: 'materialize' }>;
	  };

/**
 * What typing into the `inputPath` of a page comes to. A path moves the file of a page that has
 * one, and gives a file to a virtual page. An empty path (blanks are no path) would take the
 * file of a page away, so it is asked about; a virtual page has no file to take away.
 * @param row - The page the cell is of
 * @param draft - What was typed
 * @example
 * ```ts
 * pathEditOf({ inputPath: 'a/index.html' }, 'b/index.html'); // { kind: 'move', change: { op: 'movePath', path: 'b/index.html' } }
 * pathEditOf({ inputPath: 'a/index.html' }, ''); // { kind: 'ask' }
 * pathEditOf({ inputPath: null }, 'v/index.html'); // { kind: 'materialize', change: { op: 'materialize', path: 'v/index.html' } }
 * ```
 */
export function pathEditOf(row: Pick<Row, 'inputPath'>, draft: string): PathEdit {
	const blank = draft.trim() === '';
	if (row.inputPath === null) {
		return blank
			? { kind: 'none' }
			: { kind: 'materialize', change: { op: 'materialize', path: draft } };
	}
	if (blank) {
		return { kind: 'ask' };
	}
	const change = pathChangeOf(row, draft);
	return change === null ? { kind: 'none' } : { kind: 'move', change };
}

/**
 * What typing into the `url` of a page comes to: nothing, a move to send, or a question to ask
 * the person first (`ask`: the page would go).
 * @example
 * ```ts
 * const edit: UrlEdit = { kind: 'move', change: { op: 'moveUrl', url: '/b/' } };
 * ```
 */
export type UrlEdit =
	| { readonly kind: 'none' }
	| { readonly kind: 'ask' }
	| { readonly kind: 'move'; readonly change: Extract<Change, { op: 'moveUrl' }> };

/**
 * What typing into the `url` of a page comes to. Another URL moves the page. An empty URL
 * (blanks are no URL) is a page without a URL, which is no page: removing it is asked about.
 * @param row - The page the cell is of
 * @param draft - What was typed
 * @example
 * ```ts
 * urlEditOf({ url: '/a/' }, '/b/'); // { kind: 'move', change: { op: 'moveUrl', url: '/b/' } }
 * urlEditOf({ url: '/a/' }, ''); // { kind: 'ask' }
 * ```
 */
export function urlEditOf(row: Pick<Row, 'url'>, draft: string): UrlEdit {
	if (draft.trim() === '') {
		return { kind: 'ask' };
	}
	return draft === row.url
		? { kind: 'none' }
		: { kind: 'move', change: { op: 'moveUrl', url: draft } };
}

/**
 * What turning the box of the `virtual` column over comes to: a file for a virtual page, or a
 * question to ask the person first (`ask`: the file of the page would go).
 * @example
 * ```ts
 * const edit: VirtualEdit = { kind: 'materialize', change: { op: 'materialize', path: null } };
 * ```
 */
export type VirtualEdit =
	| { readonly kind: 'ask' }
	| {
			readonly kind: 'materialize';
			readonly change: Extract<Change, { op: 'materialize' }>;
	  };

/**
 * What turning the box of the `virtual` column over comes to. A page with a file would lose it,
 * so it is asked about. A virtual page gets a file where its URL says: no path is asked for,
 * and one can be typed into `inputPath` instead.
 * @param row - The page the cell is of
 * @example
 * ```ts
 * virtualEditOf({ inputPath: null }); // { kind: 'materialize', change: { op: 'materialize', path: null } }
 * virtualEditOf({ inputPath: 'a.html' }); // { kind: 'ask' }
 * ```
 */
export function virtualEditOf(row: Pick<Row, 'inputPath'>): VirtualEdit {
	return row.inputPath === null
		? { kind: 'materialize', change: { op: 'materialize', path: null } }
		: { kind: 'ask' };
}

/**
 * Whether a change of whether a page has a file still has something to change when its turn in
 * the queue of the edits comes. A box that is clicked twice asks twice, and the first answer
 * has made the page what the second asks for: sending it would only be refused, and the
 * refusal would be said right after the edit was made.
 * @param row - The page as the screen holds it when the change is to be sent
 * @param change - The change
 * @example
 * ```ts
 * stillToMake({ inputPath: 'a.html' }, { op: 'materialize', path: null }); // false
 * stillToMake({ inputPath: null }, { op: 'materialize', path: null }); // true
 * stillToMake({ inputPath: null }, { op: 'virtualize' }); // false
 * ```
 */
export function stillToMake(row: Pick<Row, 'inputPath'>, change: Change): boolean {
	if (change.op === 'materialize') {
		return row.inputPath === null;
	}
	if (change.op === 'virtualize') {
		return row.inputPath !== null;
	}
	return true;
}

/**
 * What the form that adds a page asks for; not `ok` when it says neither a URL nor a path.
 * @example
 * ```ts
 * const page: NewPage = { ok: true, url: null, path: 'about/index.html' };
 * ```
 */
export type NewPage =
	| {
			readonly ok: true;
			/** The URL of the page; `null` for the URL the place of the file gives. */
			readonly url: string | null;
			/** The path of the page file; `null` for a virtual page. */
			readonly path: string | null;
	  }
	| { readonly ok: false };

/**
 * What the form that adds a page asks for. With a path, a page file is made, and the URL is the
 * one of its place unless one is written. Without a path there is no file: the page is virtual,
 * and its URL has to be written.
 * @param url - What was typed as the URL
 * @param path - What was typed as the path of the file
 * @example
 * ```ts
 * newPageOf('', 'about/index.html'); // { ok: true, url: null, path: 'about/index.html' }
 * newPageOf('/service/', ''); // { ok: true, url: '/service/', path: null }
 * newPageOf('', ''); // { ok: false }
 * ```
 */
export function newPageOf(url: string, path: string): NewPage {
	const wantedUrl = url.trim();
	const wantedPath = path.trim();
	if (wantedUrl === '' && wantedPath === '') {
		return { ok: false };
	}
	return {
		ok: true,
		url: wantedUrl === '' ? null : wantedUrl,
		path: wantedPath === '' ? null : wantedPath,
	};
}

/**
 * The files that go when a page loses its file: the page file, and its sidecar (the `.json` of
 * the same name) when it has one. They are named as the screen names a path, from `dir.input`.
 *
 * The name of the sidecar is made by the rule of the core (`sidecar_path` of
 * `crates/kd_core/src/lib.rs`: the extension of the page file becomes `.json`), written again
 * here because a row says whether there is a sidecar (its hash) and not its name. A page file
 * has one of four extensions (`.html`, `.htm`, `.tsx`, `.jsx`), for which the two rules give
 * the same name; the names are shown to the person, and the core removes the files by its own.
 * @param row - The page
 * @example
 * ```ts
 * filesOf({ inputPath: 'a/index.html', hashes: { input: '…', sidecar: '…' } }); // ['a/index.html', 'a/index.json']
 * filesOf({ inputPath: null, hashes: { input: null, sidecar: null } }); // []
 * ```
 */
export function filesOf(row: Pick<Row, 'inputPath' | 'hashes'>): string[] {
	if (row.inputPath === null) {
		return [];
	}
	return row.hashes.sidecar === null
		? [row.inputPath]
		: [row.inputPath, row.inputPath.replace(/\.[^./]*$/, '.json')];
}

/**
 * What is said once the list was read again after a page was added, made virtual or given a
 * file: what was done, and, when the page is not among the rows shown (it is on another page
 * of the list, or the search leaves it out), that it is not, so that a person who does not
 * see it knows it is there.
 * @param urls - The URLs of the rows shown
 * @param url - The URL of the page
 * @param done - What was done, as a sentence
 * @param t - Says the rest in the language of the screen (English by default)
 * @example
 * ```ts
 * saidOfPage(['/a/'], '/a/', 'Page /a/ added'); // 'Page /a/ added'
 * saidOfPage(['/a/'], '/z/', 'Page /z/ added'); // 'Page /z/ added (not on this page)'
 * ```
 */
export function saidOfPage(
	urls: readonly string[],
	url: string,
	done: string,
	t: Translate = english,
): string {
	return urls.includes(url) ? done : t('app.notOnThisPage', { said: done });
}

/**
 * The list after a page was removed: without its row, one less in all, and with the version
 * and the hash of `pages.overrides` that the answer says (the next edit is checked against that
 * hash).
 * @param rows - The list the page was removed from
 * @param url - The URL of the page
 * @param removed - The answer of the server
 * @example
 * ```ts
 * withoutPage(rows, '/a/', { version: 4, overridesHash: null }).total; // rows.total - 1
 * ```
 */
export function withoutPage(
	rows: Rows,
	url: string,
	removed: Pick<Removed, 'overridesHash' | 'version'>,
): Rows {
	return {
		...rows,
		version: removed.version,
		overridesHash: removed.overridesHash,
		total: Math.max(0, rows.total - 1),
		pages: rows.pages.filter((page) => page.url !== url),
	};
}
