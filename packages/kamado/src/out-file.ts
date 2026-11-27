/**
 * The file `--out` names, for the commands that write one (`kamado pages` and `kamado sync`):
 * what an empty name is, where a relative name is relative to, and what is said when the file
 * cannot be written, are the same for both.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Refuses an empty `--out`, which would resolve to the directory the command runs in: said before
 * the command does the work that can take a while, and not after it.
 * @param out - The value of `--out`, when it was given
 * @throws {Error} `--out needs a file name` when `out` is the empty string
 * @example
 * ```ts
 * checkOutName('');
 * // Error: --out needs a file name
 * ```
 */
export function checkOutName(out?: string): void {
	if (out === '') {
		throw new Error('--out needs a file name');
	}
}

/**
 * Writes `text` to `out`, relative to `cwd`, making the directory it is in when it is not there.
 * @param cwd - The directory a relative `out` is relative to
 * @param out - The file name as it was typed
 * @param text - What to write
 * @throws {Error} `cannot write <out>: <reason>` when the file cannot be written (an existing
 * directory, a parent that is a file)
 * @example
 * ```ts
 * writeOutFile(process.cwd(), 'maps/sync.txt', '3 changes:\n');
 * ```
 */
export function writeOutFile(cwd: string, out: string, text: string): void {
	const file = path.resolve(cwd, out);
	try {
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, text);
	} catch (error) {
		// The message of the system names the resolved path, not what was typed.
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`cannot write ${out}: ${reason}`, { cause: error });
	}
}
