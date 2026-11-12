/**
 * The JSON of the server (RFC section 14.2), as types: the answer of the core, except that
 * `inputPath` and `outputPath` are told from `dir.input` and `dir.output`. The browser cannot
 * import the types of the server (another `tsconfig`, another runtime), so they are written
 * again here; `crates/kd_napi/check/ui.check.mjs` reads the real answer through the server and
 * checks it has exactly these fields.
 */
import type { KindsSettings } from './logic/kinds.js';
import type { KeyPresentations } from './logic/labels.js';
import type { ColumnSettings } from './logic/layout.js';

/** Where a value is written: the file of the page, its sidecar, or `pages.overrides`. */
export type Origin = 'inFile' | 'sidecar' | 'overrides';

/** One key of one page, as the core lists it. */
export interface Cell {
	readonly value: unknown;
	readonly origin: Origin;
	readonly editable: boolean;
	readonly reason?: string;
}

/** One page of the list. */
export interface Row {
	readonly url: string;
	readonly inputPath: string | null;
	readonly outputPath: string;
	readonly virtual: boolean;
	readonly depth: number;
	readonly parent: string | null;
	readonly hashes: { readonly input: string | null; readonly sidecar: string | null };
	readonly meta: Readonly<Record<string, Cell>>;
}

/** What `GET /api/pages` answers. */
export interface Rows {
	readonly version: number;
	/** Where the window the list holds starts (the page that was located, when one was asked for). */
	readonly offset: number;
	readonly total: number;
	readonly columns: readonly string[];
	readonly overridesHash: string | null;
	/**
	 * The names of the layouts in `pages.layouts.dir`; `null` when the site has no such setting.
	 * The core always says it. A list without it (a value made by hand) is read as `null`.
	 */
	readonly layouts?: readonly string[] | null;
	/**
	 * How the config presents the metadata keys (`ui.keys`): a label (the name of the column) and
	 * a description, each a text or a text per language. The core always says it (`{}` when the
	 * config names none). `columnHeading` reads a list without it (a value made by hand) as `{}`.
	 */
	readonly keys?: KeyPresentations;
	/**
	 * The `pages.overrides` file, relative to the directory of the config file; `null` when the site has
	 * none. A list without it (a value made by hand) is read as `null`.
	 */
	readonly overridesFile?: string | null;
	readonly pages: readonly Row[];
	readonly warnings: readonly string[];
}

/**
 * What `POST /api/edit` takes as the change of a page that is there and stays: a key, its URL,
 * the path of its file, or whether it has a file at all (`virtualize` takes the file away and
 * keeps the page as an entry of `pages.overrides`; `materialize` gives a virtual page a file,
 * at the path, or where its URL says when the path is `null`). A page that is made and a page
 * that is removed are not changes of a page that stays: see `createPage` and `removePage`.
 * @example
 * ```ts
 * const change: Change = { op: 'materialize', path: 'service/index.html' };
 * ```
 */
export type Change =
	| { readonly op: 'set'; readonly key: string; readonly value: unknown }
	| { readonly op: 'delete'; readonly key: string }
	| { readonly op: 'moveUrl'; readonly url: string }
	| { readonly op: 'movePath'; readonly path: string }
	| { readonly op: 'virtualize' }
	| { readonly op: 'materialize'; readonly path: string | null };

/**
 * The hashes of the files an edit was made on (`null` for a file that is not there).
 * @example
 * ```ts
 * const expect: Expect = { input: 'abc…', sidecar: null, overrides: 'def…' };
 * ```
 */
export interface Expect {
	readonly input: string | null;
	readonly sidecar: string | null;
	readonly overrides: string | null;
}

/** What `GET /api/git` answers: the branch and the commit of the site's repository. */
export interface GitInfo {
	/** `null` for a detached HEAD. */
	readonly branch: string | null;
	/** The short commit hash. */
	readonly sha: string;
}

/** What `GET /api/settings` answers: the settings of the screen (RFC section 14.2). */
export interface SettingsView {
	readonly global: { readonly locale: 'auto' | 'en' | 'ja' };
	/** This project's settings; `null` before anything was saved. */
	readonly project: {
		readonly pageSize: number;
		readonly updatedAt: string;
		/** The order of the rows; absent when the rows are in the order of the plan. */
		readonly sort?: { readonly key: string; readonly desc: boolean };
		/** The layout of the columns; absent when it has not been changed. */
		readonly columns?: ColumnSettings;
		/** The columns that are an enum, with their options; absent when there is none. */
		readonly kinds?: KindsSettings;
	} | null;
	/** Why the settings file is not used as it is, or `null`. */
	readonly warning: string | null;
}

/** What `PUT /api/settings` takes. */
export interface SettingsPatch {
	readonly global?: { readonly locale?: 'auto' | 'en' | 'ja' };
	readonly project?: {
		readonly pageSize?: number;
		/** `null` puts the rows back in the order of the plan. */
		readonly sort?: { readonly key: string; readonly desc: boolean } | null;
		/** Replaces the layout as a whole; `null` puts the default back. */
		readonly columns?: ColumnSettings | null;
		/** Replaces the kinds as a whole; `null` takes them all away. */
		readonly kinds?: KindsSettings | null;
	};
}

/** What `GET /api/values` answers: the values a key has over every page. */
export interface Values {
	readonly version: number;
	/** The column asked about (`meta:<key>`). */
	readonly key: string;
	/** How many different values there are, whatever the limit of the request was. */
	readonly total: number;
	/** The most often held first. */
	readonly values: readonly { readonly value: unknown; readonly count: number }[];
}

/** What `POST /api/edit` answers when the edit was made. */
export interface Edited {
	readonly ok: true;
	readonly version: number;
	readonly overridesHash: string | null;
	readonly page: Row;
	/** What the edit left undone: a file that could not be removed and stays under another name. */
	readonly warning?: string;
}

/**
 * What `POST /api/edit` answers when the edit removed the page (`deletePage`): no page is left.
 * @example
 * ```ts
 * const removed: Removed = { ok: true, version: 4, overridesHash: null, page: null };
 * ```
 */
export interface Removed {
	readonly ok: true;
	readonly version: number;
	readonly overridesHash: string | null;
	readonly page: null;
	/** What the edit left undone: a file that could not be removed and stays under another name. */
	readonly warning?: string;
}

/** How a value differs from what the commit that is checked out (HEAD) holds. */
export type DiffKind = 'modified' | 'added' | 'deleted';

/** The difference of one cell from HEAD. */
export interface CellDiff {
	readonly kind: DiffKind;
	/** The value HEAD holds (for `modified` and `deleted`). */
	readonly head?: unknown;
	/** Whether the value can be put back as HEAD has it. */
	readonly revertible: boolean;
	/** The files putting it back writes (the places a value is written); with `revertible`. */
	readonly writes?: readonly Origin[];
}

/** The differences of one page from HEAD. */
export interface PageDiff {
	readonly url?: CellDiff;
	readonly inputPath?: CellDiff;
	readonly meta?: Readonly<Record<string, CellDiff>>;
}

/** What `POST /api/diff` answers (`null` when there is no commit to compare with). */
export interface Diffs {
	/** The commit the pages were compared with, by its id in full. */
	readonly head: { readonly oid: string };
	readonly version: number;
	/** The pages that differ, by URL. */
	readonly pages: Readonly<Record<string, PageDiff>>;
	/** The keys HEAD holds that no page has now (the screen has no column for them). */
	readonly columns: readonly string[];
}

/** An operation of `ui.syncFunctions`, as `GET /api/sync` lists it (RFC §14.2, "同期"). */
export interface SyncFunction {
	readonly name: string;
	/** As written in the config: a text, or a text per language. */
	readonly label: string | Readonly<Record<string, string>> | null;
}

/** How a sync stands. */
export type SyncStatus =
	| 'running'
	/** The script of an export is writing: what is outside may be half written until it ends. */
	| 'writing'
	| 'failed'
	| 'cancelled'
	| 'nochange'
	| 'invalid'
	| 'review'
	| 'applied'
	| 'conflict'
	| 'refused';

/** The kinds of change a sync lists. */
export type SyncKind =
	| 'deleted'
	| 'movedUrl'
	| 'movedFile'
	| 'virtualized'
	| 'materialized'
	| 'added'
	| 'meta';

/** A line of the log of a script. */
export interface SyncLogLine {
	readonly type: 'info' | 'warn' | 'error';
	readonly message: string;
}

/** What `GET /api/sync/state` answers. */
export interface SyncState {
	readonly id: string;
	readonly name: string;
	readonly status: SyncStatus;
	readonly log: readonly SyncLogLine[];
	/** The place of the next line of the log: ask for the log `after` this. */
	readonly next: number;
	/** How many lines were dropped from the start of the log. */
	readonly dropped: number;
	readonly failure?: { readonly message: string; readonly stack: string | null };
	/** Which way the sync goes, once the script has said: an import changes the files, an export what is outside. */
	readonly direction?: 'import' | 'export';
	/** For an export: `false` when the script has no `read`, so no difference can be shown. */
	readonly diffed?: boolean;
	/** For an export: how many pages the script writes out. */
	readonly targets?: number;
	/** Where the script failed or was stopped: `write` means that what is outside may be half written. */
	readonly phase?: 'read' | 'write';
	readonly problems?: { readonly total: number; readonly listed: readonly string[] };
	readonly summary?: {
		readonly counts: Readonly<Record<SyncKind, number>>;
		readonly total: number;
		readonly unsaved: { readonly total: number; readonly listed: readonly string[] };
		readonly gitUnavailable: boolean;
	};
	readonly applied?: { readonly count: number };
	readonly refused?: {
		readonly code: string;
		readonly message: string;
		readonly failures: {
			readonly total: number;
			readonly listed: readonly {
				readonly url: string | null;
				readonly op: string | null;
				readonly message: string;
			}[];
		};
	};
}

/** One change of a sync, as it is shown: texts, with the values as short previews. */
export type SyncChange =
	| {
			readonly kind: 'added';
			readonly url: string;
			readonly virtual: boolean;
			readonly inputPath: string | null;
			readonly keys: number;
	  }
	| { readonly kind: 'deleted'; readonly url: string; readonly inputPath: string | null }
	| { readonly kind: 'movedUrl'; readonly from: string; readonly to: string }
	| {
			readonly kind: 'movedFile';
			readonly url: string;
			readonly from: string | null;
			readonly to: string;
	  }
	| { readonly kind: 'virtualized'; readonly url: string; readonly inputPath: string }
	| {
			readonly kind: 'materialized';
			readonly url: string;
			readonly inputPath: string | null;
	  }
	| {
			readonly kind: 'meta';
			readonly url: string;
			readonly key: string;
			readonly before?: string;
			readonly after?: string;
	  };

/** What `GET /api/sync/changes` answers: a page of the changes of one kind. */
export interface SyncChanges {
	readonly total: number;
	readonly changes: readonly SyncChange[];
}
