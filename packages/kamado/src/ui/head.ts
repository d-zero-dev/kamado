import { spawn } from 'node:child_process';
import nodePath from 'node:path';

/**
 * What a commit holds of a file, as the core is told it (`head` of `uiDiff`, RFC §14.2): `null`
 * when the file is not in it, `'ignored'` when it is not and `.gitignore` applies to it,
 * `'skip'` when it is not compared, `'same'` when it holds what the file holds now, and the
 * blob id of what it holds (with its text, once read) when that differs.
 */
export type HeadState =
	null | 'ignored' | 'skip' | 'same' | { readonly oid: string; text?: string };

/** A file the core lists, with the git blob id of what it holds now (`null` if it is not there). */
export interface ListedFile {
	readonly path: string;
	readonly blob: string | null;
}

/** How long a `git` that reads a commit may take (a large `pages.overrides` is tens of MB). */
const TIMEOUT_MS = 10_000;

/** The most text of one file that is compared: a page file or a sidecar is far smaller. */
export const MAX_FILE_BYTES = 1024 * 1024;

/** The most text of `pages.overrides` that is compared: one file for every page of the site. */
export const MAX_OVERRIDES_BYTES = 256 * 1024 * 1024;

/** How long `git` may take to give the texts of files: more than a question about them. */
const TEXTS_TIMEOUT_MS = 60_000;

/** A commit by its id in full, as `git` writes one. */
const OBJECT_ID = /^[\da-f]{40}(?:[\da-f]{24})?$/u;

interface RunOptions {
	/** What goes to the standard input. */
	readonly input?: string;
	/** The exit codes that are an answer (`git check-ignore` exits with 1 when nothing matches). */
	readonly okCodes?: readonly number[];
	/** The most the output may be; more is a failure. */
	readonly maxBytes: number;
	/** How long `git` may take, when more than {@link TIMEOUT_MS} (the text of a large file). */
	readonly timeoutMs?: number;
}

/**
 * Runs `git` in a directory and returns what it printed, or `null` when it failed for any
 * reason (no `git`, not a repository, a refused exit code, too much output, too slow).
 * @param cwd - The directory to run in
 * @param args - The arguments, fixed by the caller: nothing from a request goes in
 * @param options - The input, the exit codes that are an answer, and the most the output may be
 */
function run(
	cwd: string,
	args: readonly string[],
	options: RunOptions,
): Promise<Buffer | null> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (result: Buffer | null) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const child = spawn('git', args, {
			cwd,
			windowsHide: true,
			// Only looks: it must not take the lock of a repository that a commit is using.
			env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
			stdio: ['pipe', 'pipe', 'ignore'],
		});
		const timer = setTimeout(() => {
			child.kill();
			done(null);
		}, options.timeoutMs ?? TIMEOUT_MS);
		const chunks: Buffer[] = [];
		let size = 0;
		child.stdout.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > options.maxBytes) {
				child.kill();
				done(null);
				return;
			}
			chunks.push(chunk);
		});
		child.on('error', () => done(null));
		child.stdin.on('error', () => {
			// `git` that ended before it read everything: its exit code says what happened.
		});
		child.on('close', (code) => {
			done(
				code !== null && (code === 0 || (options.okCodes ?? []).includes(code))
					? Buffer.concat(chunks)
					: null,
			);
		});
		child.stdin.end(options.input ?? '');
	});
}

/**
 * The commit that is checked out, by its id in full. Asked once for what follows to be about
 * one commit: the branch can be switched while a request is being answered.
 * @param cwd - A directory of the repository (the one of the config file)
 * @returns The id, or `null` when there is nothing to compare with: `git` is not installed, the
 * directory is not in a repository, or the repository has no commit yet
 * @example
 * ```ts
 * await readHeadOid('/site'); // 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
 * ```
 */
export async function readHeadOid(cwd: string): Promise<string | null> {
	const out = await run(cwd, ['rev-parse', 'HEAD'], { maxBytes: 256 });
	const text = out?.toString('utf8').trim();
	return text !== undefined && OBJECT_ID.test(text) ? text : null;
}

/**
 * The hash the repository names its objects with.
 * @param cwd - A directory of the repository
 * @returns `sha256` for a repository made with `--object-format=sha256`, `sha1` otherwise (a
 * `git` that does not know the option does not know that format either)
 * @example
 * ```ts
 * await readObjectFormat('/site'); // 'sha1'
 * ```
 */
export async function readObjectFormat(cwd: string): Promise<'sha1' | 'sha256'> {
	const out = await run(cwd, ['rev-parse', '--show-object-format'], { maxBytes: 64 });
	return out?.toString('utf8').trim() === 'sha256' ? 'sha256' : 'sha1';
}

/**
 * How many directories there are between a directory of the repository and the top of it.
 * @param cwd - A directory of the repository
 * @returns The number, or `null` when `git` could not be asked
 * @example
 * ```ts
 * await readLevelsToTop('/repository'); // 0
 * await readLevelsToTop('/repository/packages/site'); // 2
 * ```
 */
export async function readLevelsToTop(cwd: string): Promise<number | null> {
	const out = await run(cwd, ['rev-parse', '--show-cdup'], { maxBytes: 4096 });
	if (out === null) {
		return null;
	}
	// `../../` for two levels, nothing at the top.
	return out.toString('utf8').trim().split('/').filter(Boolean).length;
}

/**
 * How many directories a relative path climbs out of the one it starts from.
 * @param file - The path, relative to a directory, with `/`
 * @example
 * ```ts
 * climbs('src/a.html'); // 0
 * climbs('../content/a.html'); // 1
 * climbs('../../a/../b.html'); // 2
 * ```
 */
function climbs(file: string): number {
	let count = 0;
	for (const part of nodePath.posix.normalize(file).split('/')) {
		if (part !== '..') {
			break;
		}
		count++;
	}
	return count;
}

/**
 * One line of `git cat-file --batch-check`: the object found, or `null` when there is none.
 * @param line - A line of the answer, without its line break
 */
function parseCheck(line: string): { oid: string; type: string; size: number } | null {
	const match = /^([\da-f]{40}(?:[\da-f]{24})?) (\w+) (\d+)$/u.exec(line);
	return match === null
		? null
		: { oid: match[1] ?? '', type: match[2] ?? '', size: Number(match[3]) };
}

/**
 * What a commit holds of each of the files: which are what the files hold now, which are not in it
 * (and of those, which `.gitignore` applies to), and which differ.
 *
 * It asks `git` for the id of each file in the commit (`git cat-file --batch-check`) and compares
 * it with the id the core made of the file as it is: reading the text of the files that differ is
 * left to {@link readHeadTexts}. The paths go in the standard input and never in the arguments.
 * @param cwd - A directory of the repository (the one of the config file)
 * @param commit - The commit, by its id in full ({@link readHeadOid})
 * @param files - The files the core listed, by the path git knows them by
 * @param overridesPath - The path of `pages.overrides` among them, if it is one of the files: its
 * text may be as large as the site is
 * @param levelsToTop - {@link readLevelsToTop} of the directory, when the caller has it already
 * (it does not change while the repository stays where it is)
 * @returns The state of each file by its path, or `null` when `git` could not be asked
 * @example
 * ```ts
 * await readHeadStates('/site', oid, [{ path: 'src/a.html', blob: 'e69de29…' }], null);
 * // Map { 'src/a.html' => 'same' }
 * ```
 */
export async function readHeadStates(
	cwd: string,
	commit: string,
	files: readonly ListedFile[],
	overridesPath: string | null,
	levelsToTop?: number,
): Promise<Map<string, HeadState> | null> {
	if (!OBJECT_ID.test(commit)) {
		return null;
	}
	const states = new Map<string, HeadState>();
	if (files.length === 0) {
		return states;
	}
	// A file can be above the directory `git` is run in (the input directory of a site can be
	// `../content`), but not above the top of the repository: `git` is not asked about it, as it
	// refuses a path outside the repository and would answer for none of the others.
	const levels = levelsToTop ?? (await readLevelsToTop(cwd));
	if (levels === null) {
		return null;
	}
	const inside: ListedFile[] = [];
	for (const file of files) {
		if (climbs(file.path) > levels) {
			states.set(file.path, 'skip');
		} else {
			inside.push(file);
		}
	}
	if (inside.length === 0) {
		return states;
	}
	const checkInput = inside.map((file) => `${commit}:./${file.path}\n`).join('');
	const checked = await run(cwd, ['cat-file', '--batch-check'], {
		// `./` makes the path one from the directory `git` is run in: `<commit>:<path>` alone is one
		// from the top of the repository, and the site can be in a directory of it.
		input: checkInput,
		// A line of the answer repeats the name asked about when the object is not there, so the room is
		// what was asked and a line of its own for each.
		maxBytes: checkInput.length + 128 * inside.length + 1024,
	});
	if (checked === null) {
		return null;
	}
	const lines = checked.toString('utf8').split('\n');
	const absent: string[] = [];
	for (const [index, file] of inside.entries()) {
		const found = parseCheck(lines[index] ?? '');
		if (found === null) {
			// Not in the commit. A file that is not there now either has nothing to compare.
			states.set(file.path, null);
			if (file.blob !== null) {
				absent.push(file.path);
			}
		} else if (found.type !== 'blob') {
			states.set(file.path, 'skip');
		} else if (found.oid === file.blob) {
			states.set(file.path, 'same');
		} else if (
			found.size > (file.path === overridesPath ? MAX_OVERRIDES_BYTES : MAX_FILE_BYTES)
		) {
			states.set(file.path, 'skip');
		} else {
			states.set(file.path, { oid: found.oid });
		}
	}
	if (absent.length > 0) {
		// The files that git does not track (`pages.overrides` that a prebuild makes is the usual
		// one) are not "added": nothing of git's is compared with them.
		const ignored = await run(cwd, ['check-ignore', '--stdin', '-z'], {
			input: absent.map((path) => `${path}\0`).join(''),
			okCodes: [1],
			maxBytes: 128 * absent.length + 1024,
		});
		if (ignored !== null) {
			for (const path of ignored.toString('utf8').split('\0')) {
				if (path !== '' && states.has(path)) {
					states.set(path, 'ignored');
				}
			}
		}
	}
	return states;
}

/**
 * The text of blobs of the repository, by their ids.
 * @param cwd - A directory of the repository
 * @param oids - The ids of blobs ({@link readHeadStates} found them)
 * @param maxBytes - The most the texts may be altogether
 * @returns The text of each, or `null` for a blob that is not UTF-8; `null` for the whole when
 * `git` could not be asked
 * @example
 * ```ts
 * await readHeadTexts('/site', ['ce013625030ba8dba906f756967f9e9ca394464a'], 1_048_576);
 * // Map { 'ce01362…' => 'hello\n' }
 * ```
 */
export async function readHeadTexts(
	cwd: string,
	oids: readonly string[],
	maxBytes: number = MAX_OVERRIDES_BYTES,
): Promise<Map<string, string | null> | null> {
	const texts = new Map<string, string | null>();
	const wanted = oids.filter((oid) => OBJECT_ID.test(oid));
	if (wanted.length === 0) {
		return texts;
	}
	const out = await run(cwd, ['cat-file', '--batch'], {
		input: wanted.map((oid) => `${oid}\n`).join(''),
		maxBytes: maxBytes + 128 * wanted.length,
		timeoutMs: TEXTS_TIMEOUT_MS,
	});
	if (out === null) {
		return null;
	}
	const decoder = new TextDecoder('utf-8', { fatal: true });
	let at = 0;
	for (const oid of wanted) {
		const end = out.indexOf(0x0a, at);
		if (end === -1) {
			return null;
		}
		const found = parseCheck(out.toString('utf8', at, end));
		if (found === null || found.oid !== oid) {
			texts.set(oid, null);
			at = end + 1;
			continue;
		}
		const body = out.subarray(end + 1, end + 1 + found.size);
		if (body.length !== found.size) {
			return null;
		}
		try {
			texts.set(oid, decoder.decode(body));
		} catch {
			texts.set(oid, null);
		}
		// The text is followed by a line break of its own.
		at = end + 1 + found.size + 1;
	}
	return texts;
}
