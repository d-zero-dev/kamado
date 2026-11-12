/**
 * The entry of the worker that runs one data file (a script in `data.dir`, RFC section 3.2).
 * See `runDataFile` in `data-files.ts`.
 *
 * Why a worker for each run and not the main thread: Node cannot unload a module, so a data
 * file that was edited (or one it imports) is only seen again by a thread with a fresh module
 * cache; and a run that never ends can be ended by terminating its thread.
 */
import type { FileStamp } from './data-stamp.js';

import { readFile as readFileOf } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';

import { stampOf } from './data-stamp.js';
import { jsonProblem } from './json-value.js';

/** What the main thread tells the worker. */
export interface DataWorkerInput {
	/** The compiled module to import (absolute path). */
	readonly module: string;
	/** The directory relative paths of `readFile` are relative to. */
	readonly root: string;
	/** The time limit when the file declares none, in milliseconds. */
	readonly defaultTimeoutMs: number;
}

/** What the worker tells the main thread. */
export type DataWorkerMessage =
	| { readonly type: 'limits'; readonly timeoutMs: number }
	| { readonly type: 'read'; readonly read: FileStamp }
	| {
			readonly type: 'done';
			readonly value: unknown;
			readonly reads: readonly FileStamp[];
			/** Seconds, or `null` for a file that is never run again for its age. */
			readonly maxAge: number | null;
	  }
	| {
			readonly type: 'failed';
			readonly message: string;
			readonly reads: readonly FileStamp[];
	  };

const port = parentPort;
if (!port) {
	throw new Error('data-worker.js is a worker entry; it cannot be run directly');
}
const input = workerData as DataWorkerInput;

/**
 * Reads a declared number of seconds.
 * @param module - The module of the data file
 * @param name - The export, `maxAge` or `timeout`
 * @throws {Error} when it is declared and is not a positive, finite number
 */
function seconds(module: Record<string, unknown>, name: string): number | null {
	const value = module[name];
	if (value === undefined) {
		return null;
	}
	// The most a timer takes is 2^31 - 1 milliseconds.
	if (
		typeof value !== 'number' ||
		!Number.isFinite(value) ||
		value <= 0 ||
		value > 2_147_483
	) {
		throw new Error(
			`export const ${name} must be a positive number of seconds, at most 2147483`,
		);
	}
	return value;
}

/** Runs the file and tells the main thread what came of it. */
async function run(): Promise<DataWorkerMessage> {
	// What was read is told also when the run fails: a file that is missing is a reason
	// to run again when it appears.
	const reads = new Map<string, FileStamp>();
	try {
		const module = (await import(pathToFileURL(input.module).href)) as Record<
			string,
			unknown
		>;
		// A name that is nearly `maxAge` or `timeout` is a typo that would be ignored, and the
		// file would run with the default limit and never again for its age.
		for (const name of Object.keys(module)) {
			const plain = name.toLowerCase().replaceAll(/[^a-z]/g, '');
			if (
				(plain === 'maxage' && name !== 'maxAge') ||
				(plain === 'timeout' && name !== 'timeout')
			) {
				throw new Error(
					`export const ${name} is not read: the names are maxAge and timeout, and case matters`,
				);
			}
		}
		const timeout = seconds(module, 'timeout');
		const maxAge = seconds(module, 'maxAge');
		const timeoutMs = timeout === null ? input.defaultTimeoutMs : timeout * 1000;
		port?.postMessage({ type: 'limits', timeoutMs } satisfies DataWorkerMessage);
		if (!('default' in module)) {
			throw new Error(
				'a data file must have a default export (a value, or a function that returns it)',
			);
		}
		const readFile = async (file: string): Promise<string> => {
			const absolute = path.resolve(input.root, file);
			// The stamp is taken before the bytes are read: a change in between makes the next
			// check find the file different and run again, never the other way round.
			const stamp = await stampOf(absolute);
			reads.set(absolute, { path: absolute, stamp });
			// Told as it happens: a run that never ends is ended by the main thread, which
			// then still knows what it read.
			port?.postMessage({
				type: 'read',
				read: { path: absolute, stamp },
			} satisfies DataWorkerMessage);
			return readFileOf(absolute, 'utf8');
		};
		const given = module['default'];
		const value: unknown =
			typeof given === 'function'
				? await (given as (arguments_: unknown) => unknown)({
						readFile,
						// From the start of the thread, as the main thread counts the limit.
						signal: AbortSignal.timeout(
							Math.max(0, Math.floor(timeoutMs - performance.now())),
						),
					})
				: given;
		if (
			given !== null &&
			typeof given === 'object' &&
			typeof (given as { then?: unknown }).then === 'function'
		) {
			throw new Error(
				'the default export is a Promise: export a function that returns it, so that the file runs it when it is run',
			);
		}
		const problem = jsonProblem(value);
		if (problem !== null) {
			throw new Error(`the value is not JSON: ${problem}`);
		}
		return { type: 'done', value, reads: [...reads.values()], maxAge };
	} catch (error) {
		return {
			type: 'failed',
			message: error instanceof Error ? error.message : String(error),
			reads: [...reads.values()],
		};
	}
}

// Why a timer that does nothing: a data file whose promise never settles leaves the thread
// with nothing to wait for, and Node ends it with an exit code instead of letting the main
// thread, which holds the time limit, say that the file did not finish.
const keepAlive = setInterval(() => {}, 1 << 30);
port.postMessage(await run());
clearInterval(keepAlive);
