/**
 * @file Whether a script of `scripts/` is the one Node was started with, so that it
 * writes its files when it is run and not when a spec imports it.
 */
import { realpathSync } from 'node:fs';

/**
 * Whether Node was started with this file. Node resolves the main module through
 * symbolic links while `argv[1]` keeps the path as given, so the path is resolved
 * before it is compared. Without a path (`--eval`), or with a path of no file (a
 * runner's), it is not.
 * @param {string} filename - `import.meta.filename` of the script
 * @param {string | undefined} [argv1] - The path Node was started with
 * @returns {boolean} Whether the script is the one that runs
 * @example
 * if (isMain(import.meta.filename)) {
 * 	writeFileSync(output, render());
 * }
 */
export function isMain(filename, argv1 = process.argv[1]) {
	if (!argv1) {
		return false;
	}
	try {
		return realpathSync(argv1) === filename;
	} catch {
		return false;
	}
}
