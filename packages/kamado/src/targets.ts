/**
 * The entries of `targets` (the globs of `kamado build`) turned into the
 * absolute globs the core matches against the input files. Not exported from
 * the package: `build()` and the CLI are its only callers.
 *
 * Why not real paths: the core names an input file by the directory of the
 * config file, `dir.input` and the path the walk took, without resolving the
 * links on the way. An entry is matched in the same form, so `baseDir` and
 * the config file must be named the same way (the CLI takes both real).
 */
import { statSync } from 'node:fs';
import path from 'node:path';

/** The characters that make an entry of `targets` a glob. */
const GLOB_CHARACTERS = /[*?[\]{}]/;

/**
 * `p` with `/` between its directories, and every character the glob reads
 * escaped (the glob characters, `!`, the backslash, and the `(` `)` `|` `+`
 * `@` of extglobs, which the glob refuses), so that a directory named
 * `a[1]` or `site (copy)` is matched as it is written.
 * @param p - A path of the system
 */
function asLiteralPattern(p: string): string {
	return p
		.split(path.sep)
		.join('/')
		.replaceAll(/[*?[\]{}()|!+@\\]/g, String.raw`\$&`);
}

/**
 * `glob` with the `.` and `..` segments before its first glob segment
 * resolved, and the rest kept as written: after `*`, `..` is part of what the
 * glob asks for, and resolving it would match other files.
 * @param glob - A glob with `/` between its segments
 */
function normalizeHead(glob: string): string {
	const segments = glob.split('/');
	// An escaped character (`\[` of an escaped directory name) is not a glob one.
	const first = segments.findIndex((segment) =>
		GLOB_CHARACTERS.test(segment.replaceAll(/\\./g, '')),
	);
	const head = segments.slice(0, first).join('/');
	const tail = segments.slice(first).join('/');
	return head === '' ? tail : `${path.posix.normalize(head)}/${tail}`;
}

/**
 * The entries of `targets` as absolute globs, the form the core matches
 * against the input files. A relative entry is resolved from `baseDir`. An
 * entry without a glob character is a path: it must exist, and a directory
 * stands for every file under it. A glob keeps what it is written with (a
 * backslash in it is an escape, not a separator), under `baseDir` when
 * relative.
 * @param targets - The entries as they were written
 * @param baseDir - The directory a relative entry is relative to
 * @returns The globs, in the order of `targets`
 * @throws {Error} when an entry is empty, a path that does not exist, or a negated glob
 * @example
 * ```ts
 * resolveTargets(['css/style.css', 'news', 'blog/**'], '/site');
 * // ['/site/css/style.css', '/site/news/**', '/site/blog/**']
 * ```
 */
export function resolveTargets(targets: readonly string[], baseDir: string): string[] {
	const base = path.resolve(baseDir);
	return targets.map((target) => {
		// An unset variable in a script (`kamado build "$FILE"`) would otherwise
		// name the base directory, and with it every file.
		if (target === '') {
			throw new Error('an empty target is not supported');
		}
		if (target.startsWith('!')) {
			throw new Error(`negated glob ${JSON.stringify(target)} is not supported`);
		}
		if (!GLOB_CHARACTERS.test(target)) {
			const file = path.resolve(base, target);
			const stat = statSync(file, { throwIfNoEntry: false });
			if (!stat) {
				throw new Error(`target not found: ${target} (${file})`);
			}
			return stat.isDirectory() ? `${asLiteralPattern(file)}/**` : asLiteralPattern(file);
		}
		return normalizeHead(
			path.isAbsolute(target) ? target : `${asLiteralPattern(base)}/${target}`,
		);
	});
}
