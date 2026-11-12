/**
 * `kamado sync <name|path>` (RFC §13 and §14.2, "同期"): runs the script, shows what its answer
 * would change on the standard error, asks on the terminal, and applies it.
 *
 * Everything it says goes to the standard error, as the log of the script does: the standard
 * output is not a result a program reads. The exit code is 0 when the sync ended (changes
 * applied, none to apply, or declined at the question), 1 when it failed or applied nothing for
 * a reason (the script failed, what it returned cannot be applied, the core refused, there are
 * changes and nobody could confirm them), and 130 when it was cancelled with Ctrl-C.
 */
import type { Run } from './runner.js';
import type { SyncSummary } from './types.js';

import { styleText } from 'node:util';

import {
	displayChange,
	displayFailure,
	displayProblem,
	type DisplayChange,
} from './display.js';
import { runSync, SyncError, type SyncReport, type SyncRun } from './sync.js';
import { showControls } from './terminal.js';

/** The flags `kamado sync` reads, as `parseArgs` gives them. */
export interface SyncFlags {
	readonly config?: string;
	readonly 'cache-dir'?: string;
	readonly yes?: boolean;
}

/** What the command needs of its surroundings. */
export interface SyncCommandContext {
	/** The directory a path given on the command line is relative to. */
	readonly cwd: string;
	/** The absolute path of the config file (`--config`, or the one in the cwd). */
	readonly resolveConfig: () => string;
	/** Writes to the standard error. */
	readonly write: (text: string) => void;
	/** Whether the standard input and error are a terminal that can be asked. */
	readonly interactive: boolean;
	/** Asks a question on the terminal and gives the answer typed. Rejects when the question is cancelled. */
	readonly ask: (question: string) => Promise<string>;
	/** The run that does the work (default: {@link runSync}). */
	readonly run?: (
		configPath: string,
		target: string,
		options: SyncRun,
	) => Promise<SyncReport>;
}

/** The most changes the confirmation lists before it says how many more there are. */
const MAX_LISTED = 200;

/** The most files of unsaved changes the warning names. */
const MAX_NAMED = 20;

/**
 * One change as a line of the confirmation.
 * @param change - A change that is already safe to show
 */
function lineOf(change: DisplayChange): string {
	switch (change.kind) {
		case 'added': {
			const how = change.virtual
				? 'virtual'
				: change.inputPath === null
					? 'file at its URL'
					: change.inputPath;
			return `+ ${change.url} (${how}${change.keys > 0 ? `, ${change.keys} ${change.keys === 1 ? 'key' : 'keys'}` : ''})`;
		}
		case 'deleted': {
			return `- ${change.url}${change.inputPath === null ? '' : ` (${change.inputPath})`}`;
		}
		case 'movedUrl': {
			return `~ ${change.from} -> ${change.to}`;
		}
		case 'movedFile': {
			return `~ ${change.url}: ${change.from ?? '(virtual)'} -> ${change.to}`;
		}
		case 'virtualized': {
			return `~ ${change.url}: ${change.inputPath} -> virtual`;
		}
		case 'materialized': {
			return `~ ${change.url}: virtual -> ${change.inputPath ?? 'a file at its URL'}`;
		}
		case 'meta': {
			const before = change.before === undefined ? '' : `${change.before} -> `;
			return `* ${change.url} ${change.key}: ${before}${change.after ?? '(removed)'}`;
		}
	}
}

/**
 * The summary as the text the confirmation shows.
 * @param summary - What the sync would change
 * @returns The lines, each ending with a newline
 * @example
 * ```ts
 * summaryText({ counts: { added: 1, deleted: 0, movedUrl: 0, movedFile: 0, virtualized: 0, materialized: 0, meta: 0 }, changes: [{ kind: 'added', url: '/n/', virtual: true, inputPath: null, keys: 0 }], unsaved: [] });
 * // '1 change:\n+ /n/ (virtual)\n'
 * ```
 */
export function summaryText(summary: SyncSummary): string {
	const total = summary.changes.length;
	const lines = [`${total} ${total === 1 ? 'change' : 'changes'}:`];
	for (const change of summary.changes.slice(0, MAX_LISTED)) {
		lines.push(lineOf(displayChange(change)));
	}
	if (total > MAX_LISTED) {
		lines.push(`... and ${total - MAX_LISTED} more`);
	}
	if (summary.gitUnavailable === true) {
		lines.push(
			'warning: git cannot bring these changes back (this is not a repository, or nothing is committed yet)',
		);
	} else if (summary.unsaved.length > 0) {
		const named = summary.unsaved.slice(0, MAX_NAMED).map((file) => showControls(file));
		const more =
			summary.unsaved.length > MAX_NAMED
				? `, and ${summary.unsaved.length - MAX_NAMED} more`
				: '';
		lines.push(
			`warning: ${summary.unsaved.length} ${summary.unsaved.length === 1 ? 'file has changes' : 'files have changes'} that git cannot bring back (not committed, or ignored): ${named.join(', ')}${more}`,
		);
	}
	return `${lines.join('\n')}\n`;
}

/**
 * Runs `kamado sync`.
 * @param positionals - The arguments after `sync`: the name of an operation, or the path of a script
 * @param flags - The flags of the command
 * @param context - The cwd, the config, and the terminal
 * @returns The exit code
 * @throws {Error} on a mistake of the command line, or when the config, the pages or the script
 * path cannot be read
 */
export async function syncCommand(
	positionals: readonly string[],
	flags: SyncFlags,
	context: SyncCommandContext,
): Promise<number> {
	if (positionals.length !== 1) {
		throw new Error(
			'sync takes one argument: the name of an operation of ui.syncFunctions, or the path of a script',
		);
	}
	const target = positionals[0]!;
	const configPath = context.resolveConfig();
	const run = context.run ?? runSync;
	let running: Run | undefined;
	let interrupted = false;
	const onSigint = (): void => {
		interrupted = true;
		running?.cancel();
	};
	process.on('SIGINT', onSigint);
	try {
		const report = await run(configPath, target, {
			yes: flags.yes === true,
			cacheDir: flags['cache-dir'],
			cwd: context.cwd,
			write: context.write,
			onRun: (r) => {
				running = r;
			},
			confirm: async (summary) => {
				context.write(summaryText(summary));
				if (!context.interactive) {
					throw new Error(
						'there are changes to apply, and nothing was applied: this is not a terminal to confirm them on (pass --yes to apply them)',
					);
				}
				let answer: string;
				try {
					answer = await context.ask('Apply these changes? [y/N] ');
				} catch {
					// Ctrl-C at the question is a cancel, as it is while the script runs.
					interrupted = true;
					throw new SyncError('cancelled', 'the sync was cancelled');
				}
				return /^y(?:es)?$/iu.test(answer.trim());
			},
		});
		switch (report.kind) {
			case 'nothing': {
				context.write('The script returned nothing, so nothing was applied.\n');
				return 0;
			}
			case 'nochange': {
				context.write('No changes: the pages are what the script returned.\n');
				return 0;
			}
			case 'declined': {
				context.write('Nothing was applied.\n');
				return 0;
			}
			case 'applied': {
				context.write(
					`Applied ${report.summary.changes.length} ${report.summary.changes.length === 1 ? 'change' : 'changes'}. Look at them with git diff, and git reset what you do not want.\n`,
				);
				return 0;
			}
		}
	} catch (error) {
		if (interrupted) {
			context.write(`${styleText('bold', 'Cancelled.')} Nothing was applied.\n`);
			return 130;
		}
		if (!(error instanceof SyncError)) {
			throw error;
		}
		switch (error.kind) {
			case 'failed': {
				const shown = displayFailure({
					message: error.message,
					stack: error.scriptStack,
				});
				context.write(`${styleText(['bold', 'red'], shown.message)}\n`);
				if (shown.stack !== null) {
					context.write(`${styleText('dim', shown.stack)}\n`);
				}
				context.write('Nothing was applied.\n');
				break;
			}
			case 'invalid': {
				context.write(
					`${styleText(['bold', 'red'], 'The script returned pages that cannot be applied, so nothing was applied:')}\n`,
				);
				for (const problem of error.problems ?? []) {
					context.write(`  ${displayProblem(problem)}\n`);
				}
				break;
			}
			case 'refused': {
				context.write(`${styleText(['bold', 'red'], showControls(error.message))}\n`);
				for (const failure of error.failures ?? []) {
					context.write(
						`  ${failure.url === null ? '' : `${showControls(failure.url)} `}${failure.op ?? ''}: ${showControls(failure.message)}\n`,
					);
				}
				break;
			}
			default: {
				context.write(`${styleText(['bold', 'red'], showControls(error.message))}\n`);
			}
		}
		return error.kind === 'cancelled' ? 130 : 1;
	} finally {
		process.off('SIGINT', onSigint);
	}
}
