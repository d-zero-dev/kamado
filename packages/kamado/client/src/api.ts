import type { ColumnDefaults } from './logic/layout.js';
import type { SortState } from './logic/sort.js';
import type {
	Change,
	Diffs,
	Edited,
	Expect,
	GitInfo,
	Removed,
	Row,
	Rows,
	SettingsPatch,
	SettingsView,
	SyncChanges,
	SyncFunction,
	SyncKind,
	SyncState,
	Values,
} from './types.js';

import { parseColumnDefaults } from './logic/column-defaults.js';
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
 * The layout of the columns the config gives (`ui.defaultKeyOrder`, `ui.defaultFixedKeys`), as the
 * server placed it in the page. Read from the page and not asked for: the server has the config
 * when it serves the page, and the screen has it even when its settings cannot be read.
 */
export function columnDefaults(): ColumnDefaults {
	return parseColumnDefaults(
		document.querySelector<HTMLMetaElement>('meta[name="kamado-column-defaults"]')
			?.content,
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
 * @param locate - The URL of a page whose window is wanted instead of the one at `offset` (the
 * answer says where the window it holds starts, in `offset`)
 */
export function fetchRows(
	offset: number,
	limit: number,
	q: string,
	sort: SortState | null,
	signal?: AbortSignal,
	locate?: string,
): Promise<Rows> {
	const query = new URLSearchParams({
		offset: String(offset),
		limit: String(limit),
		...sortParams(sort),
	});
	if (q !== '') {
		query.set('q', q);
	}
	if (locate !== undefined) {
		query.set('locate', locate);
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
 * Makes a page that is not there: a page file at `path`, or a virtual page (an entry of
 * `pages.overrides`) when there is no path.
 * @param url - The URL the page is to have; `null` for the URL the place of the file gives
 * @param path - The path of the page file, from `dir.input`; `null` for a virtual page
 * @param overridesHash - The hash of `pages.overrides` as the screen read it (`null` for none):
 * a virtual page is written there
 * @example
 * ```ts
 * await createPage(null, 'about/index.html', null); // the page /about/
 * await createPage('/service/', null, 'abc…'); // a virtual page
 * ```
 */
export function createPage(
	url: string | null,
	path: string | null,
	overridesHash: string | null,
): Promise<Edited> {
	return call<Edited>('/api/edit', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Kamado-Token': token() },
		body: JSON.stringify({
			url,
			expect: { overrides: overridesHash },
			change: { op: 'create', path },
		}),
	});
}

/**
 * Removes a page: its file and its sidecar, and its entry in `pages.overrides`.
 * @param url - The page
 * @param expect - The hashes of the files the screen read the page from
 * @example
 * ```ts
 * await removePage('/about/', { input: 'abc…', sidecar: null, overrides: null });
 * ```
 */
export function removePage(url: string, expect: Expect): Promise<Removed> {
	return call<Removed>('/api/edit', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Kamado-Token': token() },
		body: JSON.stringify({ url, expect, change: { op: 'deletePage' } }),
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

/**
 * The operations of `ui.syncFunctions` (RFC §14.2, "同期"): the names and the labels, as written.
 * @param signal - To give up on an answer that does not come
 * @example
 * ```ts
 * await fetchSyncFunctions(); // [{ name: 'import-sheet', label: { en: 'Import' } }]
 * ```
 */
export async function fetchSyncFunctions(signal?: AbortSignal): Promise<SyncFunction[]> {
	const answer = await call<{ functions: SyncFunction[] }>('/api/sync', { signal });
	return answer.functions;
}

/**
 * Starts the operation named `name`. The name is all the server is given: the script is the
 * one the config says, and nothing else can be run from the screen.
 * @param name - The name of an operation
 * @returns The id of the sync
 * @throws {ApiError} `busy` when a sync is running, `unknown` for a name the config does not have
 */
export async function startSync(name: string): Promise<string> {
	const answer = await call<{ id: string }>('/api/sync/run', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Kamado-Token': token() },
		body: JSON.stringify({ name }),
	});
	return answer.id;
}

/**
 * How the sync stands, and the lines of its log from `after` on.
 * @param id - The sync
 * @param after - The place of the next line the screen has not read
 * @param signal - To drop an answer that is not wanted any more
 */
export function fetchSyncState(
	id: string,
	after: number,
	signal?: AbortSignal,
): Promise<SyncState> {
	const query = new URLSearchParams({ id, after: String(after) });
	return call<SyncState>(`/api/sync/state?${query.toString()}`, { signal });
}

/**
 * A page of the changes of one kind of the sync.
 * @param id - The sync
 * @param kind - The kind of change
 * @param offset - The first change
 * @param limit - How many changes
 * @param signal - To drop an answer that is not wanted any more
 */
export function fetchSyncChanges(
	id: string,
	kind: SyncKind,
	offset: number,
	limit: number,
	signal?: AbortSignal,
): Promise<SyncChanges> {
	const query = new URLSearchParams({
		id,
		kind,
		offset: String(offset),
		limit: String(limit),
	});
	return call<SyncChanges>(`/api/sync/changes?${query.toString()}`, { signal });
}

/**
 * Applies what the sync showed. The id is all the server is given: it applies the edits it
 * kept, not edits from the screen.
 * @param id - The sync
 * @returns The state of the sync after it
 */
export function applySync(id: string): Promise<SyncState> {
	return call<SyncState>('/api/sync/apply', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Kamado-Token': token() },
		body: JSON.stringify({ id }),
	});
}

/**
 * Stops the sync while its script runs.
 * @param id - The sync
 */
export async function cancelSync(id: string): Promise<void> {
	await call<{ cancelled: boolean }>('/api/sync/cancel', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Kamado-Token': token() },
		body: JSON.stringify({ id }),
	});
}
