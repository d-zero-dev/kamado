/**
 * The child process a sync script runs in (RFC §14.2, "同期"): `runner.ts` forks it, hands it the
 * script and the pages, and reads what comes back. A script that throws, rejects, exits or
 * hangs takes only this process down, never the editor that started it.
 *
 * The script is an object (`{ select?, read?, write? }`). The child runs `select` and `read` and
 * sends what they returned. A script that has no `write` (an import) ends there. A script that has
 * one (an export) is kept waiting, because `write` must run in the process that ran `read`
 * (what `read` learned, a login for instance, is what `write` uses) and only after the parent has
 * shown the difference and had it confirmed: the parent sends `write`, and the child answers
 * `written` and leaves. `write` is given the rows `select` returned; a script without `select` is
 * given the rows of every page that the parent compared and sent with `write`, so that what it
 * writes is what the confirmation showed and the rows are made in one place.
 *
 * What it sends back is only `log`, `result`, `written` and `failure`, and the result as text (the
 * parent parses it): a value that cannot be written as JSON is a failure here, not a surprise there.
 * It does not say in which phase a failure happened (before the result, or while writing): the
 * parent knows which of the two it was waiting for.
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

interface WriteMessage {
	readonly type: 'write';
	/** The changes the confirmation showed; `null` when nothing was compared. */
	readonly changes: readonly unknown[] | null;
	/**
	 * What `write` is given as `rows` when the script has no `select` (every page, made by the
	 * parent); `null` to give what `select` returned.
	 */
	readonly rows: readonly unknown[] | null;
}

type Level = 'info' | 'warn' | 'error';
type Hook = (...args: never[]) => unknown;

/** The script of an export, kept until it is asked to write. */
interface Waiting {
	readonly write: (input: unknown, ctx: unknown) => unknown;
	readonly ctx: unknown;
	/** What `select` returned as JSON; `null` when the script has none. */
	readonly rows: readonly unknown[] | null;
	readonly pages: readonly unknown[];
}

let waiting: Waiting | undefined;
let writing = false;

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

// The parent went away while this process waited to be asked to write: nobody is left to ask.
process.on('disconnect', () => {
	if (waiting !== undefined && !writing) {
		process.exit(0);
	}
});

process.on('message', (message: RunMessage | WriteMessage) => {
	if (message?.type === 'run') {
		void run(message);
	} else if (message?.type === 'write') {
		void write(message);
	}
});

/**
 * Checks the default export of the script and picks the functions out of it.
 * @param script - The default export of the module
 * @throws {TypeError} when it is not an object with `read` (an import) or `write` (an export)
 */
function shapeOf(script: unknown): { select?: Hook; read?: Hook; write?: Hook } {
	if (typeof script !== 'object' || script === null || Array.isArray(script)) {
		const found =
			script === undefined
				? 'missing'
				: script === null
					? 'null'
					: Array.isArray(script)
						? 'an array'
						: `a ${typeof script}`;
		throw new TypeError(
			`the script must export an object by default (export default { select?, read?, write? }), but its default export is ${found}`,
		);
	}
	const object = script as Record<string, unknown>;
	for (const name of ['select', 'read', 'write']) {
		if (object[name] !== undefined && typeof object[name] !== 'function') {
			throw new TypeError(`${name} of the script must be a function`);
		}
	}
	if (object.read === undefined && object.write === undefined) {
		throw new TypeError(
			'the script must have read (to import the outside data) or write (to write the site out)',
		);
	}
	return object;
}

/**
 * Checks what `select` or `read` returned.
 * @param name - `select` or `read`
 * @param value - What it returned
 * @throws {TypeError} when it is not an array
 */
function rowsOf(name: string, value: unknown): unknown[] {
	if (!Array.isArray(value)) {
		throw new TypeError(
			`${name} of the script must return an array of pages, but it returned ${value === undefined ? 'nothing' : value === null ? 'null' : typeof value}`,
		);
	}
	return value;
}

/**
 * Imports the script, runs `select` and `read`, and sends what they returned.
 * @param message - The run
 */
async function run(message: RunMessage): Promise<void> {
	try {
		const imported = (await import(message.script)) as { default?: unknown };
		const script = shapeOf(imported.default);
		const ctx = {
			inputDir: message.inputDir,
			log(type: Level, text: string): void {
				const level: Level =
					type === 'warn' || type === 'error' || type === 'info' ? type : 'info';
				send({ type: 'log', level, message: String(text) });
			},
		};
		const call = (hook: Hook): unknown =>
			(hook as (pages: readonly unknown[], ctx: unknown) => unknown).call(
				imported.default,
				message.pages,
				ctx,
			);
		const selected =
			script.select === undefined ? null : rowsOf('select', await call(script.select));
		const current =
			script.read === undefined ? null : rowsOf('read', await call(script.read));
		const direction = script.write === undefined ? 'import' : 'export';
		let json: string | undefined;
		let normalized: unknown[] | null = null;
		try {
			// `select` is made JSON once, to be what `write` is given; the result is the text of it
			// with `read`, so that the whole result is not parsed again here.
			// (`structuredClone` would keep a Date or `undefined` that JSON turns into something else.)
			normalized =
				selected === null
					? null
					: // oxlint-disable-next-line unicorn/prefer-structured-clone
						(JSON.parse(JSON.stringify(selected)) as unknown[]);
			json = JSON.stringify({ direction, select: normalized, read: current });
		} catch (error) {
			throw new TypeError(
				`what the script returned cannot be sent as JSON: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
		if (json === undefined) {
			throw new TypeError('what the script returned cannot be sent as JSON');
		}
		if (script.write === undefined) {
			send({ type: 'result', json }, 0);
			return;
		}
		waiting = {
			write: (script.write as Waiting['write']).bind(imported.default),
			ctx,
			rows: normalized,
			pages: message.pages,
		};
		send({ type: 'result', json });
	} catch (error) {
		fail(error);
	}
}

/**
 * Writes, when the parent asks: the script's `write` is called once.
 * @param message - The changes the confirmation showed, and the rows when `select` was left out
 */
async function write(message: WriteMessage): Promise<void> {
	if (waiting === undefined || writing) {
		return;
	}
	writing = true;
	try {
		const input: Record<string, unknown> = {
			rows: message.rows ?? waiting.rows,
			pages: waiting.pages,
		};
		if (message.changes !== null) {
			input.changes = message.changes;
		}
		await waiting.write(input, waiting.ctx);
		send({ type: 'written' }, 0);
	} catch (error) {
		fail(error);
	}
}
