/**
 * `sync()` and the run that `kamado sync` makes (RFC §13 and §14.2, "同期"): opens the editor of
 * the core without a server, finds the script, runs the sync, asks for the confirmation when
 * there are changes, and applies them all together or not at all.
 *
 * Why the editor of the core and no server: the editor is what knows the pages, the hashes of
 * their files and how to apply a batch, and the screen's server only adds a door to it. A
 * command that opens the same core gets the same difference and the same refusals.
 */
import type { Problem } from './diff.js';

import { statSync } from 'node:fs';
import path from 'node:path';

import { assertKnownOptions } from '../known-options.js';
import { native } from '../native.js';

import { displayLog } from './display.js';
import { type Run } from './runner.js';
import { prepareSync, type ApplyFailure } from './session.js';
import {
	type Label,
	type SyncOptions,
	type SyncOutcome,
	type SyncSummary,
} from './types.js';

/**
 * Keys {@link sync} reads. Kept next to {@link SyncOptions} so a new field is either allowed here
 * or refused as `unknown option`.
 */
export const SYNC_OPTION_KEYS = [
	'yes',
	'cacheDir',
	'write',
] as const satisfies readonly (keyof SyncOptions)[];

/** An operation of `ui.syncFunctions`, as the core gives it. */
export interface SyncFunctionConfig {
	readonly name: string;
	readonly label: Label;
	/** Absolute. */
	readonly script: string;
}

/**
 * Why a sync did not end in changes made.
 * @example
 * ```ts
 * const kind: SyncErrorKind = 'invalid';
 * ```
 */
export type SyncErrorKind =
	/** The script failed (it threw, it ended, it could not be imported, ...). */
	| 'failed'
	/** What the script returned cannot be applied. */
	| 'invalid'
	/** The sync was cancelled. */
	| 'cancelled'
	/** The core refused the edits, and nothing was written. */
	| 'refused'
	/** There are changes, and nobody confirmed them. */
	| 'unconfirmed';

/**
 * What a sync that did not apply rejects with. `kind` says which way it ended, and the other
 * fields carry what the kind has to tell.
 * @example
 * ```ts
 * try {
 * 	await sync('/site/kamado.config.jsonc', 'import', { yes: true });
 * } catch (error) {
 * 	if (error instanceof SyncError && error.kind === 'invalid') {
 * 		console.error(error.problems?.map((p) => p.message).join('\n'));
 * 	}
 * }
 * ```
 */
export class SyncError extends Error {
	/** What the core refused, for `refused`. */
	readonly failures?: readonly ApplyFailure[];
	readonly kind: SyncErrorKind;
	/** Every problem of what the script returned, for `invalid`. */
	readonly problems?: readonly Problem[];
	/** The stack of the script, for `failed` (the stack of this error is the caller's). */
	readonly scriptStack: string | null;

	/** What would be applied, for `unconfirmed`. */
	readonly summary?: SyncSummary;

	constructor(
		kind: SyncErrorKind,
		message: string,
		extra: {
			scriptStack?: string | null;
			problems?: readonly Problem[];
			failures?: readonly ApplyFailure[];
			summary?: SyncSummary;
		} = {},
	) {
		super(message);
		this.name = 'SyncError';
		this.kind = kind;
		this.scriptStack = extra.scriptStack ?? null;
		this.problems = extra.problems;
		this.failures = extra.failures;
		this.summary = extra.summary;
	}
}

/** What a run of a sync gives when it did not throw. */
export type SyncReport =
	| { readonly kind: 'nothing' }
	| { readonly kind: 'nochange'; readonly summary: SyncSummary }
	| { readonly kind: 'declined'; readonly summary: SyncSummary }
	| { readonly kind: 'applied'; readonly summary: SyncSummary; readonly count: number };

/** What {@link runSync} takes beyond the options of {@link sync}. */
export interface SyncRun extends SyncOptions {
	/**
	 * Asked when there are changes and `yes` is not set. Resolves `true` to apply, `false` to leave.
	 * Without it, changes that are not confirmed by `yes` are an error.
	 */
	readonly confirm?: (summary: SyncSummary) => Promise<boolean> | boolean;
	/** The directory a script path is relative to (default: the cwd). */
	readonly cwd?: string;
	/** Told of the run when it starts, so that it can be cancelled. */
	readonly onRun?: (run: Run) => void;
}

/**
 * Finds the script a `kamado sync` argument names: an operation of `ui.syncFunctions` by its name
 * (looked at first, so that a name need not look unlike a path), else a file by its path.
 * @param functions - The operations of the config
 * @param target - The argument
 * @param cwd - What a relative path is relative to
 * @throws {Error} when no operation has that name and no file is at the path
 * @example
 * ```ts
 * resolveScript([{ name: 'import', label: 'Import', script: '/site/s/import.mjs' }], 'import', '/site');
 * // '/site/s/import.mjs'
 * ```
 */
export function resolveScript(
	functions: readonly SyncFunctionConfig[],
	target: string,
	cwd: string,
): string {
	const named = functions.find((f) => f.name === target);
	if (named !== undefined) {
		return named.script;
	}
	const file = path.resolve(cwd, target);
	let isFile = false;
	try {
		isFile = statSync(file).isFile();
	} catch (error) {
		const { code } = error as NodeJS.ErrnoException;
		if (code !== 'ENOENT' && code !== 'ENOTDIR') {
			// A file that cannot be looked at (no permission) is not a file that is not there.
			throw error;
		}
	}
	if (!isFile) {
		const known =
			functions.length === 0
				? 'ui.syncFunctions has no operation'
				: `ui.syncFunctions has: ${functions.map((f) => f.name).join(', ')}`;
		throw new Error(
			`no operation named ${JSON.stringify(target)} and no script at ${file} (${known})`,
		);
	}
	return file;
}

/**
 * Runs a sync and says how it ended; the changes are applied when they are confirmed.
 * @param configPath - Absolute path of `kamado.config.jsonc`
 * @param target - The name of an operation of `ui.syncFunctions`, or the path of a script
 * @param options - `yes`, `cacheDir` and where the log goes, and what asks for the confirmation
 * @returns How it ended when it did not fail
 * @throws {SyncError} when the script fails, what it returned cannot be applied, the sync is
 * cancelled, the core refuses the edits, or there are changes that nobody confirmed
 * @throws {Error} when the config or the pages cannot be read, or no script is found
 */
export async function runSync(
	configPath: string,
	target: string,
	options: SyncRun = {},
): Promise<SyncReport> {
	const write = options.write ?? ((text: string) => process.stderr.write(text));
	const core = native();
	const handle = core.uiOpen(
		configPath,
		JSON.stringify(options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir }),
	);
	// The run of this sync, kept in an object: it is set by a callback, which the type checker does
	// not follow into a plain variable.
	const started: { run?: Run } = {};
	try {
		const { syncFunctions } = JSON.parse(core.uiServer(handle)) as {
			syncFunctions?: SyncFunctionConfig[];
		};
		const script = resolveScript(
			syncFunctions ?? [],
			target,
			options.cwd ?? process.cwd(),
		);
		const prepared = await prepareSync({
			editor: { handle, ...core },
			script,
			cwd: path.dirname(configPath),
			onLog: (log) => {
				const shown = displayLog(log);
				write(`[${shown.type}] ${shown.message}\n`);
			},
			onRun: (run) => {
				started.run = run;
				options.onRun?.(run);
			},
		});
		switch (prepared.kind) {
			case 'failed': {
				throw new SyncError('failed', `the script failed: ${prepared.message}`, {
					scriptStack: prepared.stack,
				});
			}
			case 'cancelled': {
				throw new SyncError('cancelled', 'the sync was cancelled');
			}
			case 'nothing': {
				return { kind: 'nothing' };
			}
			case 'invalid': {
				const told = prepared.problems.map((p) => p.message);
				throw new SyncError(
					'invalid',
					`the script returned pages that cannot be applied, and nothing was applied (${prepared.problems.length} problems):\n${told.join('\n')}`,
					{ problems: prepared.problems },
				);
			}
			case 'nochange': {
				return { kind: 'nochange', summary: prepared.summary };
			}
			case 'review': {
				const { summary } = prepared;
				if (options.yes !== true) {
					if (options.confirm === undefined) {
						throw new SyncError(
							'unconfirmed',
							`the script returned changes, and nothing was applied: pass yes: true to apply them (${describeCounts(summary)})`,
							{ summary },
						);
					}
					if (!(await options.confirm(summary))) {
						return { kind: 'declined', summary };
					}
				}
				if (started.run?.cancelled === true) {
					// Ctrl-C after the script returned (while git was asked, or at the question).
					throw new SyncError('cancelled', 'the sync was cancelled');
				}
				const applied = prepared.apply();
				if (!applied.ok) {
					throw new SyncError('refused', `nothing was applied: ${applied.message}`, {
						failures: applied.failures,
						summary,
					});
				}
				return { kind: 'applied', summary, count: applied.count };
			}
			default: {
				const unreachable: never = prepared;
				throw new Error(`unreachable: ${JSON.stringify(unreachable)}`);
			}
		}
	} finally {
		// The editor is let go.
		// What the script left running goes with the sync (only this sync's: another sync of the
		// same process is not ours to stop).
		started.run?.cancel();
		core.uiClose(handle);
	}
}

/**
 * The counts of a summary in a line, for a message.
 * @param summary - The summary
 * @example
 * ```ts
 * describeCounts({ counts: { added: 1, deleted: 2, movedUrl: 0, movedFile: 0, virtualized: 0, materialized: 0, meta: 0 }, changes: [], unsaved: [] });
 * // '1 added, 2 deleted'
 * ```
 */
export function describeCounts(summary: SyncSummary): string {
	const names: Record<keyof SyncSummary['counts'], string> = {
		added: 'added',
		deleted: 'deleted',
		movedUrl: 'URLs moved',
		movedFile: 'files moved',
		virtualized: 'made virtual',
		materialized: 'given a file',
		meta: 'keys changed',
	};
	return (
		Object.entries(summary.counts)
			.filter(([, count]) => count > 0)
			.map(([kind, count]) => `${count} ${names[kind as keyof typeof names]}`)
			.join(', ') || 'no changes'
	);
}

/**
 * Runs the script of a sync on the pages of the site described by `configPath`, finds what
 * its answer changes, and applies the changes to the files of the local repository, all together
 * or not at all (RFC §14.2, "同期"). It is `kamado sync`'s function: the script is the one of an
 * operation of `ui.syncFunctions` named `target`, or a file when no operation has that name.
 *
 * The script runs in a process of its own, with the privileges of the caller, on the pages as
 * `kamado pages` lists them. What it returns is every page the site should have; a page that
 * exists and is not returned is removed. Nothing is written when the script returns nothing
 * (or `null`), when what it returned is what the site is, or when anything is wrong (a script that
 * fails, a result that cannot be applied, a file that changed while the script ran). There is no
 * question asked: changes are applied only with `yes: true`, and otherwise the call throws
 * (`kamado sync` asks on the terminal and then passes `yes`).
 * @param configPath - Absolute path of `kamado.config.jsonc`
 * @param target - The name of an operation of `ui.syncFunctions`, or the path of a script
 * (relative to the cwd)
 * @param options - `yes`, `cacheDir` and where the log goes
 * @returns Whether anything was applied, and what the changes were
 * @throws {SyncError} when the script fails (`kind: 'failed'`, with the message of the script), what
 * it returned cannot be applied (`invalid`, with every problem), the core refuses the edits
 * (`refused`), there are changes and `yes` is not set (`unconfirmed`), or the run was stopped from
 * outside (`cancelled`)
 * @throws {Error} when the config or the pages cannot be read, no script is found, or `options` has
 * a key that is not in {@link SYNC_OPTION_KEYS} (`unknown option: <key>`)
 * @example
 * ```ts
 * const { applied, summary } = await sync('/site/kamado.config.jsonc', 'import-sheet', {
 * 	yes: true,
 * });
 * console.log(applied, summary.counts);
 * ```
 */
export async function sync(
	configPath: string,
	target: string,
	options: SyncOptions = {},
): Promise<SyncOutcome> {
	assertKnownOptions(options, SYNC_OPTION_KEYS);
	const report = await runSync(configPath, target, options);
	const empty: SyncSummary = {
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
	switch (report.kind) {
		case 'nothing': {
			return { applied: false, summary: empty };
		}
		case 'applied': {
			return { applied: true, summary: report.summary };
		}
		default: {
			return { applied: false, summary: report.summary };
		}
	}
}
