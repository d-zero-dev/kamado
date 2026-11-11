import type { HeadState, ListedFile } from './head.js';

import {
	MAX_FILE_BYTES,
	MAX_OVERRIDES_BYTES,
	readHeadOid,
	readHeadStates,
	readHeadTexts,
	readLevelsToTop,
	readObjectFormat,
} from './head.js';

/** What the core says of the difference between pages and a commit (`uiDiff`, RFC §14.2). */
export interface DiffAnswer {
	/** The commit the pages were compared with, by its id in full. */
	readonly head: { readonly oid: string };
	readonly version: number;
	/** The pages that differ, by URL. */
	readonly pages: Readonly<Record<string, unknown>>;
	/** The keys of the commit that no page has now (the screen has no column for them). */
	readonly columns: readonly string[];
}

/** What a revert comes to: the answer of the core, or why it was not asked. */
export type RevertResult =
	| { readonly kind: 'edit'; readonly result: unknown }
	| { readonly kind: 'noHead' }
	| { readonly kind: 'headMoved' };

/** The difference from the commit that is checked out, and the edit that goes back to it. */
export interface HeadDiff {
	/**
	 * The difference of the pages at `urls` from HEAD.
	 * @param urls - The URLs of the pages
	 * @returns `null` when there is nothing to compare with (no `git`, no repository, no commit)
	 */
	diff(urls: readonly string[]): Promise<DiffAnswer | null>;
	/**
	 * Puts a key of a page back as HEAD has it.
	 * @returns `edit` with the answer of the core (it made the edit, or says why not); `noHead`
	 * when there is no commit to go back to; `headMoved` when the commit that is checked out is not
	 * the one the screen compared with (nothing is written then)
	 * @param request - What the screen asks for
	 * @param request.url - The page
	 * @param request.expect - The hashes of the files the screen read the page from
	 * @param request.key - The key of the metadata (`null` for the one that makes the URL)
	 * @param request.head - The commit the screen compared with, by its id in full
	 */
	revert(request: {
		readonly url: string;
		readonly expect: unknown;
		readonly key: string | null;
		readonly head: string;
	}): Promise<RevertResult>;
}

/** What `createHeadDiff` needs of the native core. */
export interface HeadDiffCore {
	uiDiffFiles(handle: string, queryJson: string): string;
	uiDiff(handle: string, queryJson: string): string;
	uiEdit(handle: string, editJson: string): string;
}

interface FilesAnswer {
	readonly files: readonly ListedFile[];
	readonly overrides: ListedFile | null;
}

/** How many files' texts are asked of `git` at once: a failure or a time out costs these and no more. */
const TEXTS_AT_ONCE = 256;

/**
 * Gives the core the texts it asked for, from the commit: each file that differs by its blob id.
 * A file it asked for that cannot be given (no text, not UTF-8, one it was not told of, or a read
 * that failed) is not compared: the core is asked again with it as `skip`, so that it never asks
 * for it twice. The texts are read a few hundred at a time (and `pages.overrides` alone), so that
 * a read that goes wrong loses the files of its own group and not the marks of the whole window.
 * @param cwd - A directory of the repository
 * @param need - The paths the core asked for
 * @param states - What the commit holds of each file
 * @param overridesPath - The path of `pages.overrides`, whose text may be as large as the site
 */
async function fillTexts(
	cwd: string,
	need: readonly string[],
	states: Map<string, HeadState>,
	overridesPath: string | null,
): Promise<void> {
	const groups: string[][] = [];
	const others = need.filter((path) => path !== overridesPath);
	for (let at = 0; at < others.length; at += TEXTS_AT_ONCE) {
		groups.push(others.slice(at, at + TEXTS_AT_ONCE));
	}
	if (overridesPath !== null && need.includes(overridesPath)) {
		groups.push([overridesPath]);
	}
	for (const group of groups) {
		const oids = group.flatMap((path) => {
			const state = states.get(path);
			return typeof state === 'object' && state !== null ? [state.oid] : [];
		});
		const alone = group.length === 1 && group[0] === overridesPath;
		const texts = await readHeadTexts(
			cwd,
			oids,
			alone ? MAX_OVERRIDES_BYTES : MAX_FILE_BYTES * group.length,
		);
		for (const path of group) {
			const state = states.get(path);
			const text =
				typeof state === 'object' && state !== null ? texts?.get(state.oid) : undefined;
			if (typeof state === 'object' && state !== null && typeof text === 'string') {
				state.text = text;
			} else {
				states.set(path, 'skip');
			}
		}
	}
}

/**
 * Reads what the commit holds of the files of some pages, in the form the core is told it.
 * @param cwd - A directory of the repository
 * @param core - The native core
 * @param handle - The handle of the editor
 * @param urls - The URLs of the pages
 * @param commit - The commit
 * @param format - The hash the repository names its objects with
 * @param levels - How many directories `cwd` is below the top of the repository
 * @returns The state of each file and the path of `pages.overrides`; `null` when `git` could not
 * be asked
 */
async function readStates(
	cwd: string,
	core: HeadDiffCore,
	handle: string,
	urls: readonly string[],
	commit: string,
	format: 'sha1' | 'sha256',
	levels: number,
): Promise<{ states: Map<string, HeadState>; overridesPath: string | null } | null> {
	const listed = JSON.parse(
		core.uiDiffFiles(handle, JSON.stringify({ urls, format })),
	) as FilesAnswer;
	const all =
		listed.overrides === null ? listed.files : [...listed.files, listed.overrides];
	const overridesPath = listed.overrides?.path ?? null;
	const states = await readHeadStates(cwd, commit, all, overridesPath, levels);
	return states === null ? null : { states, overridesPath };
}

/**
 * The difference from the commit that is checked out, and the edit that goes back to it (RFC
 * §14.2, "HEAD との差分"). The core compares; this finds out what `git` says of the files.
 *
 * Why the commit is read once and the files by it: the branch can be switched while the screen
 * is open, and a window of rows that was compared with one commit must not be mixed with the
 * files of another.
 * @param options - The directory of the repository, the editor of the core, and its handle
 * @param options.cwd - A directory of the repository (the one of the config file)
 * @param options.core - The native core
 * @param options.handle - The handle of the editor
 * @example
 * ```ts
 * const head = createHeadDiff({ cwd: '/site', core: native(), handle });
 * await head.diff(['/about/']); // { head: { oid }, version, pages: { … }, columns: [] }
 * ```
 */
export function createHeadDiff(options: {
	readonly cwd: string;
	readonly core: HeadDiffCore;
	readonly handle: string;
}): HeadDiff {
	const { cwd, core, handle } = options;
	// The object format of the repository, and how far down in it the site is, do not change while
	// it stays where it is: asked once and not for each window and each edit.
	let repository: { format: 'sha1' | 'sha256'; levels: number } | undefined;
	const about = async () => {
		if (repository === undefined) {
			const levels = await readLevelsToTop(cwd);
			if (levels === null) {
				return null;
			}
			repository = { format: await readObjectFormat(cwd), levels };
		}
		return repository;
	};
	return {
		async diff(urls) {
			const commit = await readHeadOid(cwd);
			if (commit === null) {
				return null;
			}
			const repo = await about();
			if (repo === null) {
				return null;
			}
			const { format, levels } = repo;
			const read = await readStates(cwd, core, handle, urls, commit, format, levels);
			if (read === null) {
				return null;
			}
			const { states, overridesPath } = read;
			// Once for the files that are not known, and once more for what the core asked for: the
			// second answer cannot ask again, as everything it asked for was given.
			for (let round = 0; round < 2; round++) {
				const answer = JSON.parse(
					core.uiDiff(
						handle,
						JSON.stringify({ urls, format, head: Object.fromEntries(states) }),
					),
				) as {
					need?: string[];
					version: number;
					pages: Record<string, unknown>;
					columns: string[];
				};
				if (answer.need === undefined) {
					return {
						head: { oid: commit },
						version: answer.version,
						pages: answer.pages,
						columns: answer.columns,
					};
				}
				await fillTexts(cwd, answer.need, states, overridesPath);
			}
			return null;
		},

		async revert(request) {
			const commit = await readHeadOid(cwd);
			if (commit === null) {
				return { kind: 'noHead' };
			}
			if (commit !== request.head) {
				return { kind: 'headMoved' };
			}
			const repo = await about();
			if (repo === null) {
				return { kind: 'noHead' };
			}
			const { format, levels } = repo;
			const read = await readStates(
				cwd,
				core,
				handle,
				[request.url],
				commit,
				format,
				levels,
			);
			if (read === null) {
				return { kind: 'noHead' };
			}
			const { states, overridesPath } = read;
			for (let round = 0; round < 2; round++) {
				// The commit is read again before each write: the branch can be switched while the files
				// are looked at, and what the screen asked for is the value of the commit it showed.
				const now = await readHeadOid(cwd);
				if (now === null) {
					return { kind: 'noHead' };
				}
				if (now !== request.head) {
					return { kind: 'headMoved' };
				}
				const result = JSON.parse(
					core.uiEdit(
						handle,
						JSON.stringify({
							url: request.url,
							expect: request.expect,
							change: {
								op: 'revert',
								key: request.key,
								head: Object.fromEntries(states),
							},
						}),
					),
				) as { ok: boolean; code?: string; need?: string[] };
				if (result.ok || result.code !== 'need' || result.need === undefined) {
					return { kind: 'edit', result };
				}
				await fillTexts(cwd, result.need, states, overridesPath);
			}
			return { kind: 'noHead' };
		},
	};
}
