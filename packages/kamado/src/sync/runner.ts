/**
 * Runs a sync script in a process of its own (RFC §14.2, "同期"). One process for each run: a
 * script that is fixed is run as fixed the next time, and one that throws, exits or hangs does
 * not take the editor with it. The pages and the result cross by IPC as JSON; the parent
 * checks the shape of the result before anything is made of it.
 *
 * A run ends in one of three ways, and the caller tells them apart: a result (what `select` and
 * `read` returned), a failure (with what went wrong), or a cancel. Nothing is a result unless the
 * script returned one. A process that ends first is a failure, whatever its exit code, because a
 * script that exits 0 before it returns has not said what the data is.
 *
 * The process of an export is not killed when its result arrives: it waits to be asked to
 * `write`, which it does in the same process that ran `read`, after the difference was confirmed.
 * Why it is kept and not run again: what `read` learned (a login, a position in a sheet) is what
 * `write` uses, and a second run would read a second time what the person confirmed.
 * Every page as rows, for a script without `select`, is made by the parent and sent with `write`:
 * the rows are made in one place (`allPages` of `compare.ts`), the one the confirmation compared.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** A line of the log of a script. */
export interface ScriptLog {
	readonly type: 'info' | 'warn' | 'error';
	readonly message: string;
}

/** How a run ended. */
export type RunOutcome =
	| {
			readonly kind: 'result';
			/** What the script returned as JSON: `{ direction, select, read }`. */
			readonly value: unknown;
	  }
	| {
			readonly kind: 'failed';
			readonly message: string;
			/** The stack, when what was thrown was an `Error`. */
			readonly stack: string | null;
	  }
	| { readonly kind: 'cancelled' };

/** How a write ended. */
export type WriteOutcome =
	| { readonly kind: 'written' }
	/**
	 * The process was gone before it was asked to write, so nothing was written: this is not the
	 * failure of a write that may have written half.
	 */
	| {
			readonly kind: 'gone';
			readonly message: string;
			/** The stack, when what was thrown was an `Error`. */
			readonly stack: string | null;
	  }
	| {
			readonly kind: 'failed';
			readonly message: string;
			/** The stack, when what was thrown was an `Error`. */
			readonly stack: string | null;
	  }
	| { readonly kind: 'cancelled' };

/** What {@link runScript} takes. */
export interface RunRequest {
	/** The absolute path of the script. */
	readonly script: string;
	/** What the script is given as its first argument. */
	readonly pages: readonly unknown[];
	/** The absolute `dir.input` (`ctx.inputDir`). */
	readonly inputDir: string;
	/**
	 * The directory the script runs in: what its relative paths (`readFile('./data.csv')`) are
	 * relative to. The directory of the config file, so that a script does the same wherever kamado
	 * was started. Without it, the directory of the process that started the run.
	 */
	readonly cwd?: string;
	/** Told of each line the script logs. */
	readonly onLog: (log: ScriptLog) => void;
	/**
	 * Told, once, when the process of an export is gone while it waits to be asked to write (it
	 * crashed, or was killed from outside): what was confirmed cannot be written any more.
	 */
	readonly onGone?: (failure: {
		readonly message: string;
		readonly stack: string | null;
	}) => void;
	/**
	 * The process to run (default: `child.js` next to this file, or `child.ts` when the package is
	 * run from its sources). A program has no reason to set it.
	 */
	readonly childFile?: string;
}

/** A run that is going on. */
export interface Run {
	/** Settles when the run ends; never rejects. */
	readonly done: Promise<RunOutcome>;
	/**
	 * Stops the script (the process is killed) and ends the run as cancelled. Safe to call at any
	 * time; a cancel asked after the script has returned is remembered in {@link Run.cancelled},
	 * because the sync is not over until it is applied, and a person who cancelled it does not
	 * want it applied. A cancel while an export writes ends the write as cancelled, and what is
	 * outside may be half written.
	 */
	readonly cancel: () => void;
	/** Whether {@link Run.cancel} was called, before or after the script ended. */
	readonly cancelled: boolean;
	/**
	 * Asks the script of an export to write, and settles when it is done; never rejects. Only after
	 * `done` gave the result of an export: the process is waiting for it.
	 * @param changes - The changes the confirmation showed; `null` when nothing was compared
	 * @param rows - What `write` is given as `rows` when the script has no `select` (every page,
	 * made by the caller); `null` to give the script what its `select` returned
	 */
	readonly write: (
		changes: readonly unknown[] | null,
		rows: readonly unknown[] | null,
	) => Promise<WriteOutcome>;
}

/**
 * The file of the child process: the compiled one next to this file, or its source.
 * @param override - A file named by the caller
 */
function childFileOf(override: string | undefined): string {
	if (override !== undefined) {
		return override;
	}
	const compiled = fileURLToPath(new URL('child.js', import.meta.url));
	return existsSync(compiled)
		? compiled
		: fileURLToPath(new URL('child.ts', import.meta.url));
}

/**
 * Whether a message from the child is a log line, which it may send at any time. Anything else
 * is looked at by its type and ignored when it is not one the parent knows: the child is the
 * project's code, and what it sends is not trusted to be the shape the parent expects.
 * @param message - What arrived
 */
function isLog(
	message: unknown,
): message is { type: 'log'; level: string; message: string } {
	const m = message as Record<string, unknown> | null;
	return (
		typeof m === 'object' &&
		m !== null &&
		m.type === 'log' &&
		typeof m.level === 'string' &&
		typeof m.message === 'string'
	);
}

/**
 * Whether the result of a script is that of an export, whose process is kept.
 * @param value - The parsed result
 */
function isExport(value: unknown): boolean {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value as Record<string, unknown>).direction === 'export'
	);
}

/**
 * Runs the script of a sync.
 * @param request - The script, what it is given, and where its log goes
 * @returns The run: what it ends in, and the means to stop it
 * @example
 * ```ts
 * const run = runScript({
 * 	script: '/site/scripts/export.mjs',
 * 	pages: [],
 * 	inputDir: '/site/src',
 * 	onLog: ({ type, message }) => console.error(`[${type}] ${message}`),
 * });
 * const outcome = await run.done;
 * ```
 */
export function runScript(request: RunRequest): Run {
	let settle!: (outcome: RunOutcome) => void;
	/**
	 * Where the run is: the script runs (`script`), an export waits to be asked to write (`idle`),
	 * it writes (`writing`), or nothing is left to do (`over`).
	 */
	let stage: 'script' | 'idle' | 'writing' | 'over' = 'script';
	const done = new Promise<RunOutcome>((resolve) => {
		settle = resolve;
	});
	let child: ChildProcess | undefined;
	let exited = false;
	let disconnected = false;
	/** Why the process of an export is gone before it was asked to write. */
	let gone: { message: string; stack: string | null } | undefined;
	let settleWrite: ((outcome: WriteOutcome) => void) | undefined;

	const end = (outcome: RunOutcome): void => {
		if (stage !== 'script') {
			return;
		}
		const keep = outcome.kind === 'result' && isExport(outcome.value);
		stage = keep ? 'idle' : 'over';
		settle(outcome);
		if (!keep) {
			// The process of the script goes with the run. A process the script started itself is
			// the script's to stop: it is not in the group that is killed.
			child?.kill('SIGKILL');
		}
	};
	const endWrite = (outcome: WriteOutcome): void => {
		if (stage !== 'writing') {
			return;
		}
		stage = 'over';
		settleWrite?.(outcome);
		child?.kill('SIGKILL');
	};
	/**
	 * The script failed, or its process is gone: told to whoever waits for it at this stage.
	 * @param message - What went wrong
	 * @param stack - The stack, when there is one
	 */
	const fail = (message: string, stack: string | null): void => {
		switch (stage) {
			case 'script': {
				end({ kind: 'failed', message, stack });
				break;
			}
			case 'writing': {
				endWrite({ kind: 'failed', message, stack });
				break;
			}
			case 'idle': {
				if (gone === undefined) {
					gone = { message, stack };
					request.onGone?.(gone);
				}
				break;
			}
			case 'over': {
				break;
			}
		}
	};
	let cancelRequested = false;
	const run: Run = {
		done,
		cancel: () => {
			cancelRequested = true;
			switch (stage) {
				case 'script': {
					end({ kind: 'cancelled' });
					break;
				}
				case 'idle': {
					stage = 'over';
					child?.kill('SIGKILL');
					break;
				}
				case 'writing': {
					endWrite({ kind: 'cancelled' });
					break;
				}
				case 'over': {
					break;
				}
			}
		},
		get cancelled() {
			return cancelRequested;
		},
		write: (changes, rows) =>
			new Promise<WriteOutcome>((resolve) => {
				if (stage === 'idle' && gone === undefined) {
					stage = 'writing';
					settleWrite = resolve;
					child?.send({ type: 'write', changes, rows }, (error) => {
						if (error !== null) {
							endWrite({
								kind: 'failed',
								message: `the changes could not be sent to the script: ${error.message}`,
								stack: error.stack ?? null,
							});
						}
					});
				} else if (stage === 'idle' && gone !== undefined) {
					stage = 'over';
					child?.kill('SIGKILL');
					resolve({
						kind: 'gone',
						message: `the script ended before it was asked to write: ${gone.message}`,
						stack: gone.stack,
					});
				} else if (stage === 'over') {
					resolve({ kind: 'cancelled' });
				} else {
					resolve({
						kind: 'failed',
						message:
							stage === 'writing'
								? 'the script is already writing'
								: 'the script has not returned yet, so it cannot be asked to write',
						stack: null,
					});
				}
			}),
	};

	try {
		child = fork(childFileOf(request.childFile), [], {
			// The script reads nothing from the terminal of the editor, and writes to it as it
			// likes. The fourth is the channel.
			stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
			env: process.env,
			cwd: request.cwd,
		});
	} catch (error) {
		end({
			kind: 'failed',
			message: `the script could not be started: ${error instanceof Error ? error.message : String(error)}`,
			stack: null,
		});
		return run;
	}

	/** The process is gone: a message that was on its way arrives before both of these are seen. */
	const checkGone = (): void => {
		if (!exited || !disconnected) {
			return;
		}
		const code = child?.exitCode ?? null;
		const signal = child?.signalCode ?? null;
		const how = signal === null ? `exit code ${code ?? 'unknown'}` : `signal ${signal}`;
		fail(
			stage === 'script'
				? `the script ended before it returned (${how})`
				: stage === 'writing'
					? `the script ended before it finished writing (${how})`
					: `the script ended while it waited to write (${how})`,
			null,
		);
	};
	child.on('error', (error) => {
		fail(error.message, error.stack ?? null);
	});
	child.on('exit', () => {
		exited = true;
		checkGone();
	});
	child.on('disconnect', () => {
		disconnected = true;
		checkGone();
	});
	child.on('message', (message: unknown) => {
		if (stage === 'over') {
			return;
		}
		if (isLog(message)) {
			request.onLog({
				type:
					message.level === 'warn' || message.level === 'error' ? message.level : 'info',
				message: message.message,
			});
			return;
		}
		const m = message as Record<string, unknown> | null;
		if (typeof m !== 'object' || m === null) {
			return;
		}
		if (m.type === 'result' && typeof m.json === 'string' && stage === 'script') {
			try {
				const value = JSON.parse(m.json) as unknown;
				end({ kind: 'result', value });
			} catch (error) {
				end({
					kind: 'failed',
					message: `what the script returned is not JSON: ${error instanceof Error ? error.message : String(error)}`,
					stack: null,
				});
			}
		} else if (m.type === 'written') {
			endWrite({ kind: 'written' });
		} else if (m.type === 'failure' && typeof m.message === 'string') {
			fail(m.message, typeof m.stack === 'string' ? m.stack : null);
		}
	});

	child.send(
		{
			type: 'run',
			script: pathToFileURL(request.script).href,
			pages: request.pages,
			inputDir: request.inputDir,
		},
		(error) => {
			if (error !== null) {
				fail(
					`the pages could not be sent to the script: ${error.message}`,
					error.stack ?? null,
				);
			}
		},
	);
	return run;
}
