/**
 * @file Helpers for the specs that compare a committed generated file (a table or a
 * module that `scripts/generate-*.mjs` writes) with what its generator writes now:
 * the version its header names, the Rust code without what `cargo fmt` changes, and
 * importing the generator without running it.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * The version of the source package that the header of a committed generated file
 * names, for the specs that compare the file with what its generator writes now.
 *
 * The specs generate with this version instead of the installed one: the header
 * records the version the file was last generated from, and a release of the source
 * package that leaves the table as it is must not fail the comparison, only one that
 * changes the table.
 * @param text - The committed generated file
 * @param header - Matches the header line, with the version as its first group
 * @returns The version
 * @example
 * committedVersion('// Source: prettier 3.9.6 (plugins/html.mjs).\n', /^\/\/ Source: prettier (\S+) /mu);
 * // '3.9.6'
 */
export function committedVersion(text: string, header: RegExp): string {
	const version = header.exec(text)?.[1];
	if (version === undefined) {
		throw new Error(
			`no header line matches ${header}: if the generator now writes another header, change the pattern in the spec to it`,
		);
	}
	return version;
}

/**
 * Rust code without what `cargo fmt --all` changes after a generator wrote it: the
 * white space and the trailing commas outside the string literals.
 *
 * What it cannot tell apart: white space between tokens and inside comments
 * (`pub static` and `pubstatic`, the wording of a `///` line), and a `"` in a char
 * literal (`'"'`), which it would read as the start of a string. The generated
 * tables have no char literal; comparing with what `cargo fmt` writes would need
 * cargo, which `yarn test` does not have.
 * @param rust - The generated or the committed file
 * @returns The code with those removed
 * @example
 * unformatted('[\n\t"a", "b",\n]') === unformatted('["a", "b"]'); // true
 */
export function unformatted(rust: string): string {
	return rust
		.replaceAll(/("(?:[^"\\]|\\.)*")|\s+/gu, '$1')
		.replaceAll(/("(?:[^"\\]|\\.)*")|,(?=[)\]])/gu, '$1');
}

/**
 * Imports a generator in a child process and tells which of its output files it
 * wrote. A generator that writes on import would rewrite the committed files on
 * every `yarn test`.
 *
 * The outputs hold their own contents the whole time: the files are committed ones
 * that other specs and scripts read and import while this runs (the specs run in
 * parallel), so a marker written into them would be read by those as the table. What
 * is set instead is the modification time of each output, to the epoch: a write by
 * the child, even of the same contents, changes it. Comparing the contents before
 * and after would not do: the spec imports the generator itself, so a generator that
 * writes on import has already written the same contents before the comparison
 * starts. The original times are put back afterwards, and the contents of an output
 * that the child wrote.
 * @param generator - The path of the generator
 * @param outputs - The paths of the files it writes when it is run
 * @returns The exit status, what it printed and the outputs it wrote
 * @example
 * const run = importGenerator('scripts/generate-entities.mjs', ['crates/kd_html/src/entities_table.rs']);
 * // { status: 0, stdout: '', changed: [] }
 */
export function importGenerator(
	generator: string,
	outputs: readonly string[],
): { status: number | null; stdout: string; changed: string[] } {
	const before = outputs.map((file) => statSync(file));
	const contents = outputs.map((file) => readFileSync(file, 'utf8'));
	try {
		for (const file of outputs) {
			utimesSync(file, 0, 0);
		}
		const url = pathToFileURL(generator).href;
		const run = spawnSync(
			process.execPath,
			['--input-type=module', '--eval', `await import(${JSON.stringify(url)});`],
			{ encoding: 'utf8' },
		);
		const changed = outputs.filter((file) => statSync(file).mtimeMs !== 0);
		return { status: run.status, stdout: run.stdout, changed };
	} finally {
		for (const [index, file] of outputs.entries()) {
			// Only a file that the child wrote is written again, with what it held.
			if (statSync(file).mtimeMs !== 0) {
				writeFileSync(file, contents[index]!);
			}
			const stat = before[index]!;
			utimesSync(file, stat.atimeMs / 1000, stat.mtimeMs / 1000);
		}
	}
}
