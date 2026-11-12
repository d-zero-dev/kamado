/**
 * One sync, from the pages the site has to the changes that are made (RFC §14.2, "同期"):
 * the pages are listed, the script is run on them, the difference of what it returned is found,
 * and the files git cannot bring back are looked for. What it gives back is what a person is
 * asked to confirm, and the means to apply it.
 *
 * It decides nothing that the pieces do not: `runner.ts` runs the script, `diff.ts` finds the
 * difference, `unsaved.ts` asks git, and the core (`uiEditBatch`) applies the edits all together
 * or not at all. What it does decide is the order, and that nothing is written before the
 * confirmation: the edits carry the hashes of the files as they were when the script was given
 * the pages, so a file that changed while the script ran, or while the person was reading,
 * makes the whole sync refuse (`conflict`).
 */
import type { Native } from '../native.js';
import type { Problem, Snapshot } from './diff.js';
import type { RunOutcome, Run, ScriptLog } from './runner.js';
import type { SyncSummary } from './types.js';

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

/** What {@link prepareSync} gives. */
export type Prepared =
	| { readonly kind: 'failed'; readonly message: string; readonly stack: string | null }
	| { readonly kind: 'cancelled' }
	/** The script returned nothing (or `null`): there is nothing to apply. */
	| { readonly kind: 'nothing' }
	/** What the script returned cannot be taken: every problem. */
	| { readonly kind: 'invalid'; readonly problems: readonly Problem[] }
	/** What the script returned is what the site is. */
	| { readonly kind: 'nochange'; readonly summary: SyncSummary }
	/** There are changes to confirm and to apply. */
	| {
			readonly kind: 'review';
			readonly summary: SyncSummary;
			readonly apply: () => ApplyResult;
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
 * 	const applied = prepared.apply();
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
	});
	request.onRun?.(run);
	const outcome: RunOutcome = await run.done;
	// A cancel asked at any time wins over what the script did (it may have failed because it
	// was killed, or returned just before).
	if (outcome.kind === 'cancelled' || run.cancelled) {
		return { kind: 'cancelled' };
	}
	if (outcome.kind === 'failed') {
		return { kind: 'failed', message: outcome.message, stack: outcome.stack };
	}
	if (outcome.value === null) {
		return { kind: 'nothing' };
	}
	if (!Array.isArray(outcome.value)) {
		return {
			kind: 'failed',
			message: 'the script must return nothing, null, or an array of pages',
			stack: null,
		};
	}
	const rows = outcome.value as unknown[];
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
		summary: {
			...found.summary,
			unsaved,
			...(gitUnavailable ? { gitUnavailable } : {}),
		},
		apply: () => applyEdits(editor, found.edits),
	};
}
