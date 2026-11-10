/**
 * The JSON of the server (RFC section 14.2), as types: the answer of the core, except that
 * `inputPath` and `outputPath` are told from `dir.input` and `dir.output`. The browser cannot
 * import the types of the server (another `tsconfig`, another runtime), so they are written
 * again here; `crates/kd_napi/check/ui.check.mjs` reads the real answer through the server and
 * checks it has exactly these fields.
 */
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
	readonly pages: readonly Row[];
	readonly warnings: readonly string[];
}

/** What `POST /api/edit` takes as the change. */
export type Change =
	| { readonly op: 'set'; readonly key: string; readonly value: unknown }
	| { readonly op: 'delete'; readonly key: string }
	| { readonly op: 'moveUrl'; readonly url: string };

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
	};
}

/** What `POST /api/edit` answers when the edit was made. */
export interface Edited {
	readonly ok: true;
	readonly version: number;
	readonly overridesHash: string | null;
	readonly page: Row;
}
