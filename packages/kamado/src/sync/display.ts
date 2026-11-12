/**
 * What of a sync is shown to a person, made safe to show (RFC §14.2, "同期"). A URL, a path, a
 * key, a value, a line of the log and the message of a failure all come from a script or from files
 * that someone wrote, so each is made one line of text with its control characters spelled out
 * before it goes to the terminal of `kamado sync` or to the screen of `kamado ui`: a terminal must
 * not obey an escape sequence in it, and a confirmation must not be rewritten by the data it
 * asks about. Values can be as large as the files are, so they are cut to a short preview.
 */
import type { Problem } from './diff.js';
import type { ScriptLog } from './runner.js';
import type { SyncChange } from './types.js';

import { cutLine, showControls, showControlsByLine } from './terminal.js';

/** The most characters of one line of the log that are shown. */
export const MAX_LOG_LINE = 2000;

/** The most characters of the preview of a value. */
export const MAX_PREVIEW = 200;

/** A change as it is shown: every text is one safe line, and a value is a preview of it. */
export type DisplayChange =
	| Exclude<SyncChange, { kind: 'meta' }>
	| {
			readonly kind: 'meta';
			readonly url: string;
			readonly key: string;
			readonly before?: string;
			readonly after?: string;
	  };

/**
 * A line of the log as it is shown.
 * @param log - What the script logged
 * @example
 * ```ts
 * displayLog({ type: 'info', message: 'a\nb' }); // { type: 'info', message: 'a\\nb' }
 * ```
 */
export function displayLog(log: ScriptLog): ScriptLog {
	return { type: log.type, message: showControls(cutLine(log.message, MAX_LOG_LINE)) };
}

/**
 * A value as a short line: JSON, cut, with its controls spelled out.
 * @param value - Any JSON value
 * @example
 * ```ts
 * previewValue({ a: [1, 2] }); // '{"a":[1,2]}'
 * previewValue('x'.repeat(500)).length; // 200
 * ```
 */
export function previewValue(value: unknown): string {
	let text: string;
	try {
		text = JSON.stringify(value) ?? String(value);
	} catch {
		text = String(value);
	}
	return showControls(cutLine(text, MAX_PREVIEW));
}

/**
 * A change as it is shown.
 * @param change - A change of a summary
 */
export function displayChange(change: SyncChange): DisplayChange {
	const text = showControls;
	switch (change.kind) {
		case 'added': {
			return {
				...change,
				url: text(change.url),
				inputPath: change.inputPath === null ? null : text(change.inputPath),
			};
		}
		case 'deleted': {
			return {
				...change,
				url: text(change.url),
				inputPath: change.inputPath === null ? null : text(change.inputPath),
			};
		}
		case 'movedUrl': {
			return { ...change, from: text(change.from), to: text(change.to) };
		}
		case 'movedFile': {
			return {
				...change,
				url: text(change.url),
				from: change.from === null ? null : text(change.from),
				to: text(change.to),
			};
		}
		case 'virtualized': {
			return { ...change, url: text(change.url), inputPath: text(change.inputPath) };
		}
		case 'materialized': {
			return {
				...change,
				url: text(change.url),
				inputPath: change.inputPath === null ? null : text(change.inputPath),
			};
		}
		case 'meta': {
			return {
				kind: 'meta',
				url: text(change.url),
				key: text(change.key),
				...('before' in change ? { before: previewValue(change.before) } : {}),
				...('after' in change ? { after: previewValue(change.after) } : {}),
			};
		}
	}
}

/**
 * A problem of the result as one safe line (its message names the row and the url).
 * @param problem - A problem
 */
export function displayProblem(problem: Problem): string {
	return showControls(problem.message);
}

/**
 * What a failure says, as it is shown: the message in one line and the stack in lines.
 * @param failure - The message and the stack of the failure
 * @param failure.message - The message
 * @param failure.stack - The stack, or `null`
 */
export function displayFailure(failure: {
	readonly message: string;
	readonly stack: string | null;
}): { message: string; stack: string | null } {
	return {
		message: showControls(failure.message),
		stack: failure.stack === null ? null : showControlsByLine(failure.stack),
	};
}
