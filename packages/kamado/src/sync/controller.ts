/**
 * The state of the sync the screen of `kamado ui` runs (RFC §14.2, "同期"): at most one sync at a
 * time, started by the name of an operation, with the log kept for the screen to read as it
 * goes, the differences kept for it to read by pages, and the edits kept here, so that the
 * screen applies what it was shown and cannot send an edit of its own.
 *
 * Why the screen asks by polling and not by a stream: the log of a script is a few lines, a
 * request every moment is cheap, and a stream is another kind of connection for the guards of
 * the server to cover. Why the log is kept short: a script can write as much as it likes, and
 * what the screen holds must not grow with it.
 */

import type { Problem } from './diff.js';
import type { Run, ScriptLog } from './runner.js';
import type { ApplyFailure, Prepared, SyncEditor, WriteResult } from './session.js';
import type { SyncFunctionConfig, SyncPhase } from './sync.js';
import type {
	Label,
	SyncChange,
	SyncChangeKind,
	SyncDirection,
	SyncSummary,
} from './types.js';

import { randomUUID } from 'node:crypto';

import {
	displayChange,
	displayFailure,
	displayLog,
	type DisplayChange,
} from './display.js';
import { prepareSync } from './session.js';
import { showControls } from './terminal.js';

/** The most lines of the log that are kept; the oldest go first, and the screen is told how many. */
export const MAX_LOG_LINES = 1000;

/** The most problems of a result that are listed (all of them are counted). */
export const MAX_PROBLEMS = 200;

/** The most files of unsaved changes that are named (all of them are counted). */
export const MAX_UNSAVED = 50;

/** The most failures of the core that are listed. */
export const MAX_FAILURES = 50;

/** The most changes a request for a page of the list may ask for. */
export const MAX_CHANGES = 500;

/** How a sync stands. */
export type SyncStatus =
	/** The script is running. */
	| 'running'
	/** The script failed (or the pages could not be listed). */
	| 'failed'
	| 'cancelled'
	/** The data is what the site is. */
	| 'nochange'
	/** What the script returned cannot be applied. */
	| 'invalid'
	/** There are changes to confirm. */
	| 'review'
	/** The script of an export is writing: what is outside may be half written until it ends. */
	| 'writing'
	| 'applied'
	/** A file changed since the script was given the pages: nothing was applied. */
	| 'conflict'
	/** The core refused the edits for another reason: nothing was applied. */
	| 'refused';

/** What `GET /api/sync/state` answers. */
export interface SyncState {
	readonly id: string;
	readonly name: string;
	readonly status: SyncStatus;
	/** The lines of the log from `after` on that are still kept. */
	readonly log: readonly ScriptLog[];
	/** The place of the next line: ask for the log `after` this. */
	readonly next: number;
	/** How many lines were dropped from the start of the log because it was too long. */
	readonly dropped: number;
	readonly failure?: { readonly message: string; readonly stack: string | null };
	/**
	 * Which way the sync goes, once the script has said (the shape of the script decides it):
	 * absent while it runs or when it failed first.
	 */
	readonly direction?: SyncDirection;
	/** For an export: `false` when the script has no `read`, so nothing was compared. */
	readonly diffed?: boolean;
	/** For an export: how many pages the script would write out. */
	readonly targets?: number;
	/**
	 * Where the script failed or was stopped, when it matters: `write` means that what is outside
	 * may be half written. Set for `failed` (`read` or `write`) and for `cancelled` (only `write`).
	 */
	readonly phase?: SyncPhase;
	readonly problems?: { readonly total: number; readonly listed: readonly string[] };
	readonly summary?: {
		readonly counts: SyncSummary['counts'];
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

/** What the screen is told of an operation. */
export interface SyncFunctionInfo {
	readonly name: string;
	/** As written in the config; the screen chooses the language. */
	readonly label: Label;
}

/** A job: one run of one operation. */
interface Job {
	readonly id: string;
	readonly name: string;
	status: SyncStatus;
	/** Absolute number of the first line held. */
	first: number;
	log: ScriptLog[];
	run?: Run;
	failure?: { message: string; stack: string | null };
	direction?: SyncDirection;
	diffed?: boolean;
	targets?: number;
	phase?: SyncPhase;
	problems?: readonly Problem[];
	summary?: SyncSummary;
	/** The changes of the summary by their kind, made when the screen first asks for a list. */
	byKind?: Map<string, SyncChange[]>;
	prepared?: Extract<Prepared, { kind: 'review' }>;
	applied?: { count: number };
	refused?: { code: string; message: string; failures: readonly ApplyFailure[] };
}

/** What {@link createSyncController} takes. */
export interface SyncControllerOptions {
	/** The editor of the core the screen edits. */
	readonly editor: SyncEditor;
	/** The operations of `ui.syncFunctions`. */
	readonly functions: readonly SyncFunctionConfig[];
	/** The directory of the config file: where git is asked. */
	readonly cwd: string;
	/**
	 * Takes the paths of the machine out of a text that goes to the screen (the screen is told
	 * no absolute path; a stack trace and an error are full of them).
	 */
	readonly scrub: (text: string) => string;
}

/** The answer to a request to start a sync. */
export type RunAnswer =
	| { readonly ok: true; readonly id: string }
	| { readonly ok: false; readonly error: 'busy' | 'unknown' };

/** The answer to a request to apply what was shown. */
export type ApplyAnswer =
	{ readonly ok: true } | { readonly ok: false; readonly error: 'unknown' | 'notReady' };

/** The sync of the screen. */
export interface SyncController {
	/** The operations, for the button. */
	readonly functions: () => readonly SyncFunctionInfo[];
	/** Starts the operation named `name`; one sync at a time. */
	readonly run: (name: string) => RunAnswer;
	/** The state of the sync `id`, or `null` when `id` is not the sync that is held. */
	readonly state: (id: string, after: number) => SyncState | null;
	/** A page of the changes of one kind of the sync `id`; `null` when `id` is not held or has none. */
	readonly changes: (
		id: string,
		kind: string,
		offset: number,
		limit: number,
	) => { readonly total: number; readonly changes: readonly DisplayChange[] } | null;
	/** Applies what was shown for the sync `id`, when it is waiting for the confirmation. */
	readonly apply: (id: string) => ApplyAnswer;
	/**
	 * Stops the sync `id`: while its script runs, while an export writes (what is outside may be half
	 * written: the state says so), or while the changes wait for the confirmation (they are dropped,
	 * and the script that waits is stopped). `false` when there is nothing to stop.
	 */
	readonly cancel: (id: string) => boolean;
	/** Stops what runs and drops what waits for a confirmation: the screen is going away. */
	readonly close: () => void;
}

const KINDS: ReadonlySet<string> = new Set<SyncChangeKind>([
	'deleted',
	'movedUrl',
	'movedFile',
	'virtualized',
	'materialized',
	'added',
	'meta',
]);

/**
 * Makes the sync of a screen.
 * @param options - The editor, the operations, where git is asked, and how a text is made fit for the screen
 * @returns The controller
 * @example
 * ```ts
 * const sync = createSyncController({ editor, functions, cwd: '/site', scrub: (t) => t });
 * const started = sync.run('import-sheet');
 * if (started.ok) {
 * 	const state = sync.state(started.id, 0);
 * }
 * ```
 */
export function createSyncController(options: SyncControllerOptions): SyncController {
	let job: Job | undefined;

	/**
	 * A text fit for the screen: the paths of the machine out, the controls spelled out.
	 * @param text - Any text that came from the script, the files or the core
	 */
	const fit = (text: string): string => showControls(options.scrub(text));

	const push = (target: Job, log: ScriptLog): void => {
		const shown = displayLog({ type: log.type, message: options.scrub(log.message) });
		target.log.push(shown);
		if (target.log.length > MAX_LOG_LINES) {
			const over = target.log.length - MAX_LOG_LINES;
			target.log.splice(0, over);
			target.first += over;
		}
	};

	const settle = (target: Job, prepared: Prepared): void => {
		if (target.status !== 'running') {
			return;
		}
		switch (prepared.kind) {
			case 'failed': {
				target.status = 'failed';
				target.failure = { message: prepared.message, stack: prepared.stack };
				target.phase = 'read';
				break;
			}
			case 'cancelled': {
				target.status = 'cancelled';
				break;
			}
			case 'invalid': {
				target.status = 'invalid';
				target.problems = prepared.problems;
				break;
			}
			case 'nochange': {
				target.status = 'nochange';
				target.direction = prepared.direction;
				target.summary = prepared.summary;
				break;
			}
			case 'review': {
				target.status = 'review';
				target.direction = prepared.direction;
				target.summary = prepared.summary;
				target.prepared = prepared;
				if (prepared.direction === 'export') {
					target.diffed = prepared.diffed;
					target.targets = prepared.targets;
				}
				break;
			}
		}
	};

	/**
	 * Ends the write of an export: the script wrote, or it did not.
	 * @param target - The job
	 * @param result - How the write ended
	 */
	const settleWrite = (target: Job, result: WriteResult): void => {
		if (target.status !== 'writing') {
			return;
		}
		switch (result.kind) {
			case 'written': {
				target.status = 'applied';
				target.applied = { count: result.count };
				break;
			}
			case 'conflict': {
				target.status = 'conflict';
				target.refused = { code: 'conflict', message: result.message, failures: [] };
				break;
			}
			case 'failed': {
				target.status = 'failed';
				target.failure = { message: result.message, stack: result.stack };
				target.phase = 'write';
				break;
			}
			case 'notWritten': {
				// Nothing was written: the script was gone before it was asked to, or the pages could
				// not be listed again.
				target.status = 'failed';
				target.failure = { message: result.message, stack: result.stack };
				target.phase = 'read';
				break;
			}
			case 'cancelled': {
				target.status = 'cancelled';
				target.phase = 'write';
				break;
			}
		}
	};

	/**
	 * Lets go of what a sync that is not going to be applied still holds: the script of an
	 * export waits in its process for a confirmation, and is stopped.
	 * @param target - The job
	 */
	const discard = (target: Job): void => {
		if (target.prepared?.direction === 'export') {
			target.prepared.discard();
		}
		target.prepared = undefined;
	};

	return {
		functions: () => options.functions.map((f) => ({ name: f.name, label: f.label })),

		run(name) {
			if (job?.status === 'running' || job?.status === 'writing') {
				return { ok: false, error: 'busy' };
			}
			const operation = options.functions.find((f) => f.name === name);
			if (operation === undefined) {
				return { ok: false, error: 'unknown' };
			}
			// A confirmation that was left (the tab was closed) is not applied by a later sync: the
			// script that waits for it is stopped.
			if (job?.status === 'review') {
				discard(job);
			}
			const target: Job = {
				id: randomUUID(),
				name,
				status: 'running',
				first: 0,
				log: [],
			};
			job = target;
			prepareSync({
				editor: options.editor,
				script: operation.script,
				cwd: options.cwd,
				// The pages the script is given are the ones on disk now: what the screen holds is
				// from when it was opened.
				refresh: true,
				onLog: (log) => push(target, log),
				onRun: (run) => {
					target.run = run;
				},
				onGone: ({ message, stack }) => {
					// The script of an export died while its confirmation was shown: it can no longer
					// be applied, so the state says so (and why) to whoever asks for it next.
					if (target.status === 'review' && target.prepared?.direction === 'export') {
						target.prepared = undefined;
						target.status = 'failed';
						target.failure = { message, stack };
						target.phase = 'read';
					}
				},
			}).then(
				(prepared) => settle(target, prepared),
				(error: unknown) => {
					// The pages could not be listed: the core's failure, told as a failure of the sync.
					settle(target, {
						kind: 'failed',
						message: error instanceof Error ? error.message : String(error),
						stack: null,
					});
				},
			);
			return { ok: true, id: target.id };
		},

		state(id, after) {
			if (job?.id !== id) {
				return null;
			}
			const current = job;
			const start = Math.max(0, after - current.first);
			const state: {
				-readonly [K in keyof SyncState]: SyncState[K];
			} = {
				id: current.id,
				name: current.name,
				status: current.status,
				log: current.log.slice(start),
				next: current.first + current.log.length,
				dropped: current.first,
			};
			if (current.direction !== undefined) {
				state.direction = current.direction;
			}
			if (current.diffed !== undefined) {
				state.diffed = current.diffed;
			}
			if (current.targets !== undefined) {
				state.targets = current.targets;
			}
			if (current.phase !== undefined) {
				state.phase = current.phase;
			}
			if (current.failure !== undefined) {
				const shown = displayFailure({
					message: options.scrub(current.failure.message),
					stack:
						current.failure.stack === null ? null : options.scrub(current.failure.stack),
				});
				state.failure = shown;
			}
			if (current.problems !== undefined) {
				state.problems = {
					total: current.problems.length,
					listed: current.problems
						.slice(0, MAX_PROBLEMS)
						.map((problem) => fit(problem.message)),
				};
			}
			if (current.summary !== undefined) {
				state.summary = {
					counts: current.summary.counts,
					total: current.summary.changes.length,
					unsaved: {
						total: current.summary.unsaved.length,
						listed: current.summary.unsaved.slice(0, MAX_UNSAVED).map(fit),
					},
					gitUnavailable: current.summary.gitUnavailable === true,
				};
			}
			if (current.applied !== undefined) {
				state.applied = current.applied;
			}
			if (current.refused !== undefined) {
				state.refused = {
					code: current.refused.code,
					message: fit(current.refused.message),
					failures: {
						total: current.refused.failures.length,
						listed: current.refused.failures.slice(0, MAX_FAILURES).map((failure) => ({
							url: failure.url === null ? null : fit(failure.url),
							op: failure.op,
							message: fit(failure.message),
						})),
					},
				};
			}
			return state;
		},

		changes(id, kind, offset, limit) {
			if (job?.id !== id || job.summary === undefined) {
				return null;
			}
			if (!KINDS.has(kind)) {
				return null;
			}
			// Grouped once: a list of a hundred thousand changes is asked for a page at a time, and
			// each page must not walk all of it.
			if (job.byKind === undefined) {
				job.byKind = new Map();
				for (const change of job.summary.changes) {
					const group = job.byKind.get(change.kind);
					if (group === undefined) {
						job.byKind.set(change.kind, [change]);
					} else {
						group.push(change);
					}
				}
			}
			const of = job.byKind.get(kind) ?? [];
			const size = Math.min(Math.max(1, limit), MAX_CHANGES);
			return {
				total: of.length,
				changes: of.slice(offset, offset + size).map((change) => {
					// Every field of a shown change is a text or a number or a flag: the texts are
					// told without the paths of the machine, one by one (a path in a JSON text could
					// be cut where a quote or a backslash is).
					const shown = displayChange(change);
					return Object.fromEntries(
						Object.entries(shown).map(([key, value]) => [
							key,
							typeof value === 'string' ? options.scrub(value) : value,
						]),
					) as unknown as DisplayChange;
				}),
			};
		},

		apply(id) {
			if (job?.id !== id) {
				return { ok: false, error: 'unknown' };
			}
			const { prepared } = job;
			if (job.status !== 'review' || prepared === undefined) {
				return { ok: false, error: 'notReady' };
			}
			// What was shown is applied once: a second request finds nothing to apply.
			job.prepared = undefined;
			if (prepared.direction === 'export') {
				// The script writes in its own process, and the screen follows by asking for the state.
				const target = job;
				target.status = 'writing';
				prepared.write().then(
					(written) => settleWrite(target, written),
					(error: unknown) => {
						settleWrite(target, {
							kind: 'failed',
							message: error instanceof Error ? error.message : String(error),
							stack: null,
						});
					},
				);
				return { ok: true };
			}
			const result = prepared.apply();
			if (result.ok) {
				job.status = 'applied';
				job.applied = { count: result.count };
			} else {
				job.status = result.code === 'conflict' ? 'conflict' : 'refused';
				job.refused = {
					code: result.code,
					message: result.message,
					failures: result.failures,
				};
			}
			return { ok: true };
		},

		cancel(id) {
			if (job?.id !== id) {
				return false;
			}
			if (job.status === 'running' || job.status === 'writing') {
				// While the script runs, or an export writes (what is outside may be half written).
				job.run?.cancel();
				return true;
			}
			if (job.status === 'review') {
				// The confirmation is dropped: nothing is applied, and the script that waits is stopped.
				discard(job);
				job.status = 'cancelled';
				return true;
			}
			return false;
		},

		close() {
			if (job?.status === 'running' || job?.status === 'writing') {
				job.run?.cancel();
			} else if (job?.status === 'review') {
				discard(job);
			}
		},
	};
}
