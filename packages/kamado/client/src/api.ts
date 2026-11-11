import type { SortState } from './logic/sort.js';
import type {
	Change,
	Diffs,
	Edited,
	GitInfo,
	Row,
	Rows,
	SettingsPatch,
	SettingsView,
	Values,
} from './types.js';

import { sortParams } from './logic/sort.js';

/** An answer that was not a success. */
export class ApiError extends Error {
	/** `conflict`, `invalid`, `collision`, `notEditable`, `notFound`, `io`, `forbidden`, ... */
	readonly code: string;
	/** The page as the files hold it now, with a `conflict`. */
	readonly current: Row | undefined;
	readonly status: number;

	constructor(status: number, code: string, message: string, current?: Row) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.code = code;
		this.current = current;
	}
}

/**
 * The token the server placed in the page.
 */
function token(): string {
	return (
		document.querySelector<HTMLMetaElement>('meta[name="kamado-token"]')?.content ?? ''
	);
}

/**
 * Calls the server and reads the JSON of the answer.
 * @param path - The path
 * @param init - `fetch` options
 * @throws {ApiError} on an answer that is not a success, and when none came
 */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
	let response: Response;
	try {
		response = await fetch(path, init);
	} catch (error) {
		throw new ApiError(
			0,
			'network',
			`the server did not answer (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	const text = await response.text();
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		body = undefined;
	}
	if (!response.ok) {
		const failure = (body ?? {}) as { error?: string; message?: string; current?: Row };
		throw new ApiError(
			response.status,
			failure.error ?? 'failed',
			failure.message ?? (text || response.statusText),
			failure.current,
		);
	}
	if (body === undefined) {
		throw new ApiError(response.status, 'failed', 'the answer of the server is not JSON');
	}
	return body as T;
}

/**
 * A window of the list.
 * @param offset - The first row
 * @param limit - How many rows
 * @param q - The search, if any
 * @param sort - The order of the rows, or `null` for the order of the plan
 * @param signal - To drop an answer that is not wanted any more
 */
export function fetchRows(
	offset: number,
	limit: number,
	q: string,
	sort: SortState | null,
	signal?: AbortSignal,
): Promise<Rows> {
	const query = new URLSearchParams({
		offset: String(offset),
		limit: String(limit),
		...sortParams(sort),
	});
	if (q !== '') {
		query.set('q', q);
	}
	return call<Rows>(`/api/pages?${query.toString()}`, { signal });
}

/**
 * The values a metadata key has over every page, most often held first.
 * @param column - The column (`meta:<key>`)
 * @param limit - The most values to answer with
 * @param signal - To drop an answer that is not wanted any more
 */
export function fetchValues(
	column: string,
	limit: number,
	signal?: AbortSignal,
): Promise<Values> {
	const query = new URLSearchParams({ key: column, limit: String(limit) });
	return call<Values>(`/api/values?${query.toString()}`, { signal });
}

/**
 * The branch and the commit of the site's repository, or `null` when there is none to show.
 * @param signal - To drop an answer that is not wanted any more
 * @example
 * ```ts
 * await fetchGit(); // { branch: 'main', sha: '51df987' }
 * ```
 */
export function fetchGit(signal?: AbortSignal): Promise<GitInfo | null> {
	return call<GitInfo | null>('/api/git', { signal });
}

/**
 * The settings the screen keeps between runs.
 * @param signal - To give up on an answer that does not come
 */
export function fetchSettings(signal?: AbortSignal): Promise<SettingsView> {
	return call<SettingsView>('/api/settings', { signal });
}

/**
 * Keeps a change of the settings.
 * @param patch - What changed
 * @returns The settings after the change
 */
export function saveSettings(patch: SettingsPatch): Promise<SettingsView> {
	return call<SettingsView>('/api/settings', {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json', 'X-Kamado-Token': token() },
		body: JSON.stringify(patch),
	});
}

/** Has the core read the site again. */
export function refreshSite(): Promise<{ version: number }> {
	return call<{ version: number }>('/api/refresh', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Kamado-Token': token() },
		body: '{}',
	});
}

/**
 * Makes one edit.
 * @param url - The page
 * @param expect - The hashes of the files the edit was made on
 * @param expect.input - The hash of the page file (`null` for none)
 * @param expect.sidecar - The hash of its sidecar (`null` for none)
 * @param expect.overrides - The hash of `pages.overrides` (`null` for none)
 * @param change - The change
 */
export function editPage(
	url: string,
	expect: { input: string | null; sidecar: string | null; overrides: string | null },
	change: Change,
): Promise<Edited> {
	return call<Edited>('/api/edit', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Kamado-Token': token() },
		body: JSON.stringify({ url, expect, change }),
	});
}

/**
 * The difference of some pages from the commit that is checked out.
 * @param urls - The URLs of the pages (the window on the screen)
 * @param signal - To drop an answer that is not wanted any more
 * @returns `null` when there is nothing to compare with (no git, no repository, no commit)
 * @example
 * ```ts
 * await fetchDiff(['/about/']); // { head: { oid }, version: 4, pages: { '/about/': { … } }, columns: [] }
 * ```
 */
export function fetchDiff(
	urls: readonly string[],
	signal?: AbortSignal,
): Promise<Diffs | null> {
	return call<Diffs | null>('/api/diff', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Kamado-Token': token() },
		body: JSON.stringify({ urls }),
		signal,
	});
}

/**
 * Puts a value back as the commit that is checked out has it.
 * @param url - The page
 * @param expect - The hashes of the files the screen read the page from
 * @param expect.input - The hash of the page file (`null` for none)
 * @param expect.sidecar - The hash of its sidecar (`null` for none)
 * @param expect.overrides - The hash of `pages.overrides` (`null` for none)
 * @param key - The key of the metadata; `null` for the key that makes the URL
 * @param head - The commit the screen compared with ({@link fetchDiff}), by its id in full
 */
export function revertCell(
	url: string,
	expect: { input: string | null; sidecar: string | null; overrides: string | null },
	key: string | null,
	head: string,
): Promise<Edited> {
	return call<Edited>('/api/revert', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Kamado-Token': token() },
		body: JSON.stringify({ url, expect, key, head }),
	});
}
