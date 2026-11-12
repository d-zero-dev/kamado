/**
 * The child process a sync script runs in (RFC §14.2, "同期"): `runner.ts` forks it, hands it the
 * script and the pages, and reads what comes back. A script that throws, rejects, exits or
 * hangs takes only this process down, never the editor that started it.
 *
 * What it sends back is only `log`, `result` and `failure`, and the result as text (the
 * parent parses it): a value that cannot be written as JSON is a failure here, not a surprise there.
 *
 * It imports nothing of the package, so that it runs as it is (by `node child.ts` where Node strips
 * types, which is how the specs run it) as well as compiled.
 */

interface RunMessage {
	readonly type: 'run';
	/** The `file:` URL of the module of the script. */
	readonly script: string;
	readonly pages: readonly unknown[];
	readonly inputDir: string;
}

type Level = 'info' | 'warn' | 'error';

/**
 * Sends a message to the parent, and then leaves when asked.
 * @param message - What to send
 * @param exitWith - An exit code to leave with once the message is out; none to stay
 */
function send(message: unknown, exitWith?: number): void {
	if (typeof process.send !== 'function') {
		process.exit(exitWith ?? 1);
	}
	process.send(message, undefined, undefined, () => {
		if (exitWith !== undefined) {
			process.exit(exitWith);
		}
	});
}

/**
 * Says what went wrong, as the message and the stack of an `Error`, or the text of anything else
 * that was thrown, and leaves.
 * @param error - What was thrown or what a promise was rejected with
 */
function fail(error: unknown): void {
	if (error instanceof Error) {
		send({ type: 'failure', message: error.message, stack: error.stack ?? null }, 1);
		return;
	}
	let text: string;
	try {
		text = typeof error === 'string' ? error : (JSON.stringify(error) ?? String(error));
	} catch {
		text = String(error);
	}
	send({ type: 'failure', message: text, stack: null }, 1);
}

process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

process.on('message', (message: RunMessage) => {
	if (message?.type !== 'run') {
		return;
	}
	void run(message);
});

/**
 * Imports the script, runs it, and sends what it returned.
 * @param message - The run
 */
async function run(message: RunMessage): Promise<void> {
	try {
		const imported = (await import(message.script)) as { default?: unknown };
		const script = imported.default;
		if (typeof script !== 'function') {
			throw new TypeError(
				`the script must export a function by default (export default async (pages, ctx) => …), but its default export is ${script === undefined ? 'missing' : typeof script}`,
			);
		}
		const ctx = {
			inputDir: message.inputDir,
			log(type: Level, text: string): void {
				const level: Level =
					type === 'warn' || type === 'error' || type === 'info' ? type : 'info';
				send({ type: 'log', level, message: String(text) });
			},
		};
		const value: unknown = await script(message.pages, ctx);
		if (value !== undefined && value !== null && !Array.isArray(value)) {
			throw new TypeError(
				`the script must return nothing, null, or an array of pages, but it returned ${typeof value}`,
			);
		}
		let json: string | undefined;
		try {
			json = JSON.stringify(value ?? null);
		} catch (error) {
			throw new TypeError(
				`what the script returned cannot be sent as JSON: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
		if (json === undefined) {
			throw new TypeError('what the script returned cannot be sent as JSON');
		}
		send({ type: 'result', json }, 0);
	} catch (error) {
		fail(error);
	}
}
