/**
 * `kamado pages`, apart from the command line so that it can be run with other streams and a
 * clock: the plan is one synchronous call of the core, with no spinner to show, so the command
 * says on the standard error that it is reading before the call, and what it wrote after it.
 */
import type { PageMap, PagesOptions } from './pages.js';

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { pagesJson } from './pages.js';

/** What the command needs from the process. */
export interface PagesCommandIO {
	/** The directory a relative `out` is relative to. */
	readonly cwd: string;
	readonly stdout: (text: string) => void;
	readonly stderr: (text: string) => void;
	/** Milliseconds, from any starting point. */
	readonly now: () => number;
}

/** The flags of `kamado pages`. */
export interface PagesCommandOptions extends PagesOptions {
	/** The file to write; the standard output when it is not given. */
	readonly out?: string;
}

/**
 * The process's streams and clock, for the command line.
 */
function processIO(): PagesCommandIO {
	return {
		cwd: process.cwd(),
		stdout: (text) => process.stdout.write(text),
		stderr: (text) => process.stderr.write(text),
		now: () => performance.now(),
	};
}

/**
 * Writes the pages of the plan as JSON to `options.out` (relative to `io.cwd`) or to the
 * standard output, and tells the progress on the standard error: `Reading pages...` before the
 * plan, `Wrote <out> (1,234 pages) in 0.8s` (or `Listed 1,234 pages in 0.8s` without `out`)
 * after it.
 * @param configPath - Absolute path of the config file
 * @param options - The flags
 * @param io - The streams and the clock (the process's by default)
 * @throws {Error} when `out` is empty (before the plan is read), on a configuration or plan
 * error (before anything is written), and when the file cannot be written
 * (`cannot write <out>: <reason>`, for example when `out` is a directory)
 * @example
 * ```ts
 * // kamado pages --out maps/map.json --incremental
 * pagesCommand('/site/kamado.config.jsonc', { out: 'maps/map.json', incremental: true });
 * ```
 */
export function pagesCommand(
	configPath: string,
	options: PagesCommandOptions,
	io: PagesCommandIO = processIO(),
): void {
	// An empty name resolves to the directory the command runs in: say what is wrong now,
	// not after a plan that can take a while.
	if (options.out === '') {
		throw new Error('--out needs a file name');
	}
	io.stderr('Reading pages...\n');
	const started = io.now();
	const text = pagesJson(configPath, {
		incremental: options.incremental,
		cacheDir: options.cacheDir,
	});
	const map = JSON.parse(text) as Pick<PageMap, 'pages' | 'warnings'>;
	const count = map.pages.length;
	if (options.out === undefined) {
		io.stdout(`${text}\n`);
	} else {
		const file = path.resolve(io.cwd, options.out);
		try {
			mkdirSync(path.dirname(file), { recursive: true });
			writeFileSync(file, `${text}\n`);
		} catch (error) {
			// The message of the system names the resolved path, not what was typed.
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`cannot write ${options.out}: ${reason}`, { cause: error });
		}
	}
	// The warnings are in the map for the program that reads it; on the terminal they are
	// what `build` shows them as, so that a conflict is not missed when the map goes to a file.
	for (const warning of map.warnings) {
		io.stderr(`warning: ${warning}\n`);
	}
	const seconds = ((io.now() - started) / 1000).toFixed(1);
	const pages = `${count.toLocaleString('en-US')} ${count === 1 ? 'page' : 'pages'}`;
	io.stderr(
		options.out === undefined
			? `Listed ${pages} in ${seconds}s\n`
			: `Wrote ${options.out} (${pages}) in ${seconds}s\n`,
	);
}
