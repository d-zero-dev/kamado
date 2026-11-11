/**
 * The JSON of the server (RFC section 14.2), as types: the answer of the core, except that
 * `inputPath` and `outputPath` are told from `dir.input` and `dir.output`. The browser cannot
 * import the types of the server (another `tsconfig`, another runtime), so they are written
 * again here; `crates/kd_napi/check/ui.check.mjs` reads the real answer through the server and
 * checks it has exactly these fields.
 */
import type { KindsSettings } from './logic/kinds.js';
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
	readonly total: number;
	readonly columns: readonly string[];
	readonly overridesHash: string | null;
	/**
	 * The names of the layouts in `pages.layouts.dir`; `null` when the site has no such setting.
	 * The core always says it. A list without it (a value made by hand) is read as `null`.
	 */
	readonly layouts?: readonly string[] | null;
	/**
	 * The `pages.overrides` file, relative to the directory of the config file; `null` when the site has
	 * none. A list without it (a value made by hand) is read as `null`.
	 */
	readonly overridesFile?: string | null;
	readonly pages: readonly Row[];
	readonly warnings: readonly string[];
}

/** What `POST /api/edit` takes as the change. */
export type Change =
	| { readonly op: 'set'; readonly key: string; readonly value: unknown }
	| { readonly op: 'delete'; readonly key: string }
	| { readonly op: 'moveUrl'; readonly url: string }
	| { readonly op: 'movePath'; readonly path: string };

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
