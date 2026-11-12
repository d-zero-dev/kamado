/**
 * Runs a sync script in a process of its own (RFC §14.2, "同期"). One process for each run: a
 * script that is fixed is run as fixed the next time, and one that throws, exits or hangs does
 * not take the editor with it. The pages and the result cross by IPC as JSON; the parent
 * checks the shape of the result before anything is made of it.
 *
 * A run ends in one of three ways, and the caller tells them apart: a result (`null` for "write
 * nothing", or an array), a failure (with what went wrong), or a cancel. Nothing is a result
 * unless the script returned one. A process that ends first is a failure, whatever its exit
 * code, because a script that exits 0 before it returns has not said what the site should be.
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
			/** What the script returned as JSON: `null`, or an array. */
			readonly value: unknown;
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
	 * want it applied.
	 */
	readonly cancel: () => void;
	/** Whether {@link Run.cancel} was called, before or after the script ended. */
	readonly cancelled: boolean;
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
 * Whether a message from the child is one of the three it may send, and has the fields it
 * should. Anything else is ignored: the child is the project's code, and what it sends is not
 * trusted to be the shape the parent expects.
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
	let ended = false;
	const done = new Promise<RunOutcome>((resolve) => {
		settle = resolve;
	});
	let child: ChildProcess | undefined;
	let exited = false;
	let disconnected = false;

	const end = (outcome: RunOutcome): void => {
		if (ended) {
			return;
		}
		ended = true;
		settle(outcome);
		// The process of the script goes with the run. A process the script started itself is
		// the script's to stop: it is not in the group that is killed.
		child?.kill('SIGKILL');
	};
	let cancelRequested = false;
	const run: Run = {
		done,
		cancel: () => {
			cancelRequested = true;
			end({ kind: 'cancelled' });
		},
		get cancelled() {
			return cancelRequested;
		},
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
		end({
			kind: 'failed',
			message:
				signal === null
					? `the script ended before it returned (exit code ${code ?? 'unknown'})`
					: `the script ended before it returned (signal ${signal})`,
			stack: null,
		});
	};
	child.on('error', (error) => {
		end({ kind: 'failed', message: error.message, stack: error.stack ?? null });
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
		if (ended) {
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
		if (m.type === 'result' && typeof m.json === 'string') {
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
		} else if (m.type === 'failure' && typeof m.message === 'string') {
			end({
				kind: 'failed',
				message: m.message,
				stack: typeof m.stack === 'string' ? m.stack : null,
			});
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
				end({
					kind: 'failed',
					message: `the pages could not be sent to the script: ${error.message}`,
					stack: error.stack ?? null,
				});
			}
		},
	);
	return run;
}
