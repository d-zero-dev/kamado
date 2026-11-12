/**
 * One sync, from the pages the site has to the changes that are made (RFC §14.2, "同期"):
 * the pages are listed, the script is run on them, the difference of what it returned is found,
 * and the files git cannot bring back are looked for. What it gives back is what a person is
 * asked to confirm, and the means to apply it.
 *
 * It decides nothing that the pieces do not: `runner.ts` runs the script, `diff.ts` finds the
 * difference, `compare.ts` finds the range (`select`) and the difference of an export,
 * `unsaved.ts` asks git, and the core (`uiEditBatch`) applies the edits all together
 * or not at all. What it does decide is the order, and that nothing is written before the
 * confirmation: the edits carry the hashes of the files as they were when the script was given
 * the pages, so a file that changed while the script ran, or while the person was reading,
 * makes the whole sync refuse (`conflict`).
 */
import type { Native } from '../native.js';
import type { Problem, Snapshot } from './diff.js';
import type { RunOutcome, Run, ScriptLog } from './runner.js';
import type { SyncDirection, SyncSummary } from './types.js';

import { allPages, exportChanges, importRows } from './compare.js';
import { diff } from './diff.js';
import { runScript } from './runner.js';
import { findUnsaved } from './unsaved.js';

/** What a sync needs of the editor of the core (see `Native`). */
export type SyncEditor = Pick<
	Native,
	'uiRefresh' | 'uiSyncPages' | 'uiSyncLocked' | 'uiEditBatch'
> & {
	/** The handle of the editor. */
	readonly handle: string;
};

/** An edit the core refused when the batch was made. */
export interface ApplyFailure {
	/** The URL of the page the edit named; `null` for a failure no edit is behind. */
	readonly url: string | null;
	/** The operation of the edit; `null` when no edit is behind the failure. */
	readonly op: string | null;
	readonly code: string;
	readonly message: string;
}

/** What applying the edits gave. */
export type ApplyResult =
	| { readonly ok: true; readonly count: number }
	| {
			readonly ok: false;
			/** The code of the first failure (`conflict`, `invalid`, `collision`, ...). */
			readonly code: string;
			readonly message: string;
			readonly failures: readonly ApplyFailure[];
	  };

/** What writing out gave. */
export type WriteResult =
	| { readonly kind: 'written'; readonly count: number }
	/** The site is not what it was when the difference was found: nothing was written. */
	| { readonly kind: 'conflict'; readonly message: string }
	/** The script failed while it wrote: what is outside may be half written. */
	| { readonly kind: 'failed'; readonly message: string; readonly stack: string | null }
	/**
	 * Nothing was written, and the script did not fail while it wrote: it was gone before it was
	 * asked to, or the pages could not be listed again to check that they are as they were.
	 */
	| {
			readonly kind: 'notWritten';
			readonly message: string;
			readonly stack: string | null;
	  }
	/** The sync was cancelled while the script wrote: what is outside may be half written. */
	| { readonly kind: 'cancelled' };

/** What {@link prepareSync} gives. */
export type Prepared =
	/** The script failed (`read`, which includes `select`). */
	| { readonly kind: 'failed'; readonly message: string; readonly stack: string | null }
	| { readonly kind: 'cancelled' }
	/** What the script returned cannot be taken: every problem. */
	| { readonly kind: 'invalid'; readonly problems: readonly Problem[] }
	/** The outside data is what the site is (the difference is empty). */
	| {
			readonly kind: 'nochange';
			readonly direction: SyncDirection;
			readonly summary: SyncSummary;
	  }
	/** An import: there are changes to the site to confirm and to apply. */
	| {
			readonly kind: 'review';
			readonly direction: 'import';
			readonly summary: SyncSummary;
			readonly apply: () => ApplyResult;
	  }
	/**
	 * An export: there are changes to the outside data to confirm, and the means to write them out.
	 * Nothing is written until `write` is called, and `discard` ends a script that is waiting.
	 */
	| {
			readonly kind: 'review';
			readonly direction: 'export';
			readonly summary: SyncSummary;
			/** `false` when the script has no `read`: nothing was compared, and the summary is empty. */
			readonly diffed: boolean;
			/** How many pages the script would write out. */
			readonly targets: number;
			readonly write: () => Promise<WriteResult>;
			readonly discard: () => void;
	  };

/** What {@link prepareSync} takes. */
export interface PrepareRequest {
	readonly editor: SyncEditor;
	/** The absolute path of the script. */
	readonly script: string;
	/** The directory of the config file: where git is asked, and where the script runs. */
	readonly cwd: string;
	/** Told of each line the script logs. */
	readonly onLog: (log: ScriptLog) => void;
	/**
	 * Told of the run as soon as it starts, so that the caller can cancel it. Called once, before
	 * the script is run.
	 */
	readonly onRun?: (run: Run) => void;
	/**
	 * Told, once, when the script of an export is gone while it waits for the confirmation to be
	 * answered: what is shown cannot be written any more.
	 */
	readonly onGone?: (failure: {
		readonly message: string;
		readonly stack: string | null;
	}) => void;
	/**
	 * Read the files again before the pages are listed: the editor of a screen that is open has
	 * pages from when it was opened, and what changed on disk since must be what the script is given.
	 */
	readonly refresh?: boolean;
}

/**
 * A page of the list as the script is given it: the entry of `kamado pages`, without the hashes
 * (they are for the edits that are made afterwards, and for nobody else).
 * @param page - A page of the list the core gave
 */
function entryOf(page: Snapshot['pages'][number]): Record<string, unknown> {
	const { hashes, ...entry } = page;
	void hashes;
	return entry;
}

/**
 * Applies the edits of a batch with the core and tells what came of it.
 * @param editor - The editor of the core
 * @param edits - The edits of the batch
 */
function applyEdits(
	editor: SyncEditor,
	edits: readonly {
		readonly url: string;
		readonly change: Readonly<Record<string, unknown>>;
	}[],
): ApplyResult {
	let answer: {
		ok: boolean;
		count?: number;
		code?: string;
		message?: string;
		errors?: { index: number | null; code: string; message: string }[];
	};
	try {
		answer = JSON.parse(
			editor.uiEditBatch(editor.handle, JSON.stringify({ edits })),
		) as typeof answer;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			code: 'failed',
			message,
			failures: [{ url: null, op: null, code: 'failed', message }],
		};
	}
	if (answer.ok) {
		return { ok: true, count: answer.count as number };
	}
	const failures: ApplyFailure[] = (answer.errors ?? []).map((error) => {
		const edit = error.index === null ? undefined : edits[error.index];
		return {
			url: edit?.url ?? null,
			op: typeof edit?.change.op === 'string' ? edit.change.op : null,
			code: error.code,
			message: error.message,
		};
	});
	return {
		ok: false,
		code: answer.code ?? failures[0]?.code ?? 'failed',
		message: answer.message ?? failures[0]?.message ?? 'the edits were refused',
		failures,
	};
}

/**
 * Lists the pages, runs the script on them, and finds what its answer changes.
 * @param request - The editor, the script, and where its log goes
 * @returns How it ended: what to tell, or the changes to confirm with the means to apply them
 * @throws {Error} when the pages cannot be listed (a failure of the core, not of the script)
 * @example
 * ```ts
 * const prepared = await prepareSync({
 * 	editor: { handle, ...native() },
 * 	script: '/site/scripts/import.mjs',
 * 	cwd: '/site',
 * 	onLog: ({ type, message }) => console.error(`[${type}] ${message}`),
 * });
 * if (prepared.kind === 'review') {
 * 	if (prepared.direction === 'import') {
 * 		const applied = prepared.apply();
 * 	} else {
 * 		const written = await prepared.write();
 * 	}
 * }
 * ```
 */
export async function prepareSync(request: PrepareRequest): Promise<Prepared> {
	const { editor } = request;
	if (request.refresh === true) {
		editor.uiRefresh(editor.handle);
	}
	const snapshot = JSON.parse(editor.uiSyncPages(editor.handle)) as Snapshot;
	const run = runScript({
		script: request.script,
		// What the script is given is the list of `kamado pages`: the hashes and the locks are
		// for this module and for nobody else.
		pages: snapshot.pages.map(entryOf),
		inputDir: snapshot.inputDir,
		cwd: request.cwd,
		onLog: request.onLog,
		onGone: request.onGone,
	});
	try {
		request.onRun?.(run);
		return await prepareRun(request, snapshot, run);
	} catch (error) {
		// The process of an export waits after its result: whatever throws once it is started must
		// not leave it behind.
		run.cancel();
		throw error;
	}
}

/**
 * Waits for the script to return, and finds what its answer changes.
 * @param request - The request {@link prepareSync} was given
 * @param snapshot - The pages the script was given
 * @param run - The run of the script
 */
async function prepareRun(
	request: PrepareRequest,
	snapshot: Snapshot,
	run: Run,
): Promise<Prepared> {
	const { editor } = request;
	const outcome: RunOutcome = await run.done;
	// A cancel asked at any time wins over what the script did (it may have failed because it
	// was killed, or returned just before).
	if (outcome.kind === 'cancelled' || run.cancelled) {
		return { kind: 'cancelled' };
	}
	if (outcome.kind === 'failed') {
		return { kind: 'failed', message: outcome.message, stack: outcome.stack };
	}
	const result = resultOf(outcome.value);
	if (typeof result === 'string') {
		run.cancel();
		return { kind: 'failed', message: result, stack: null };
	}
	if (result.direction === 'export') {
		return prepareExport(request, snapshot, run, result);
	}
	const made = importRows(snapshot, result.select, result.read as unknown[]);
	if (!made.ok) {
		return { kind: 'invalid', problems: made.problems };
	}
	const rows = made.rows;
	let found = diff(snapshot, rows);
	if (found.needsLocked.length > 0) {
		// The keys that cannot be edited are told for the pages whose keys the difference would
		// change, and for those only (telling them is the part of listing that is slow), and the
		// difference is made again with them.
		const told = JSON.parse(
			editor.uiSyncLocked(editor.handle, JSON.stringify({ urls: found.needsLocked })),
		) as { locked: Record<string, Record<string, string>> };
		const locked = new Map(Object.entries(told.locked));
		found = diff(
			{
				...snapshot,
				pages: snapshot.pages.map((page) => {
					const keys = locked.get(page.url);
					return keys === undefined ? page : { ...page, locked: keys };
				}),
			},
			rows,
		);
	}
	if (!found.ok) {
		return { kind: 'invalid', problems: found.problems };
	}
	if (found.edits.length === 0) {
		return {
			kind: 'nochange',
			direction: 'import',
			summary: { ...found.summary, unsaved: [] },
		};
	}
	// A cancel asked while the script ran, or after it returned and before this, ends the sync here.
	const { unsaved, gitUnavailable } = await findUnsaved({
		cwd: request.cwd,
		inputDir: snapshot.inputDir,
		files: found.filesAtRisk,
	});
	if (run.cancelled) {
		return { kind: 'cancelled' };
	}
	return {
		kind: 'review',
		direction: 'import',
		summary: {
			...found.summary,
			unsaved,
			...(gitUnavailable ? { gitUnavailable } : {}),
		},
		apply: () => applyEdits(editor, found.edits),
	};
}

/** What the child sent as the result, once it is checked. */
interface ScriptResult {
	readonly direction: SyncDirection;
	readonly select: readonly unknown[] | null;
	readonly read: readonly unknown[] | null;
}

/**
 * Checks the result the child sent. The child is the project's code, so the shape is not taken on
 * trust: what is wrong is told as the reason the script failed.
 * @param value - What the child sent, parsed
 * @returns The result, or why it cannot be one
 */
function resultOf(value: unknown): ScriptResult | string {
	const m = value as Record<string, unknown> | null;
	if (typeof m !== 'object' || m === null) {
		return 'the script must return an object of select and read';
	}
	const { direction, select, read } = m;
	if (direction !== 'import' && direction !== 'export') {
		return 'the script must be an import (read) or an export (write)';
	}
	if (select !== null && !Array.isArray(select)) {
		return 'select of the script must return an array of pages';
	}
	if (read !== null && !Array.isArray(read)) {
		return 'read of the script must return an array of pages';
	}
	if (direction === 'import' && read === null) {
		return 'the script must have read to import';
	}
	return { direction, select, read };
}

/**
 * Finds what an export would change outside, and gives the means to write it after the
 * confirmation. The script is waiting in its process, and is told to write only by `write`.
 * @param request - The request {@link prepareSync} was given
 * @param snapshot - The pages the site had when the script was given them
 * @param run - The run, whose script waits
 * @param result - What the script returned
 */
function prepareExport(
	request: PrepareRequest,
	snapshot: Snapshot,
	run: Run,
	result: ScriptResult,
): Prepared {
	const { editor } = request;
	const targets = result.select === null ? snapshot.pages.length : result.select.length;
	let summary: SyncSummary = {
		counts: {
			added: 0,
			deleted: 0,
			movedUrl: 0,
			movedFile: 0,
			virtualized: 0,
			materialized: 0,
			meta: 0,
		},
		changes: [],
		unsaved: [],
	};
	const diffed = result.read !== null;
	if (result.read !== null) {
		const found = exportChanges(snapshot, result.select, result.read);
		if (!found.ok) {
			run.cancel();
			return { kind: 'invalid', problems: found.problems };
		}
		if (found.summary.changes.length === 0) {
			run.cancel();
			return {
				kind: 'nochange',
				direction: 'export',
				summary: { ...found.summary, unsaved: [] },
			};
		}
		// The site is not written, so git has nothing to bring back: no file is at risk.
		summary = { ...found.summary, unsaved: [] };
	}
	const changes = diffed ? summary.changes : null;
	return {
		kind: 'review',
		direction: 'export',
		summary,
		diffed,
		targets,
		discard: () => run.cancel(),
		write: async () => {
			if (run.cancelled) {
				return { kind: 'cancelled' };
			}
			// What was confirmed was the difference to the site as it was: written only if it still is.
			let now: Snapshot;
			try {
				editor.uiRefresh(editor.handle);
				now = JSON.parse(editor.uiSyncPages(editor.handle)) as Snapshot;
			} catch (error) {
				run.cancel();
				return {
					kind: 'notWritten',
					message: `the pages could not be listed again before writing: ${error instanceof Error ? error.message : String(error)}`,
					stack: null,
				};
			}
			if (
				now.overridesHash !== snapshot.overridesHash ||
				JSON.stringify(now.pages) !== JSON.stringify(snapshot.pages)
			) {
				run.cancel();
				return {
					kind: 'conflict',
					message:
						'the pages of the site changed since the difference was found, so nothing was written: run the sync again',
				};
			}
			// A script without `select` is given every page as the confirmation compared them.
			const outcome = await run.write(
				changes,
				result.select === null ? allPages(snapshot) : null,
			);
			if (outcome.kind === 'written') {
				return { kind: 'written', count: diffed ? summary.changes.length : targets };
			}
			if (outcome.kind === 'gone') {
				return { kind: 'notWritten', message: outcome.message, stack: outcome.stack };
			}
			return outcome;
		},
	};
}
