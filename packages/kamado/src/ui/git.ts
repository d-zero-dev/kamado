import { execFile } from 'node:child_process';

/** The branch and the commit of a repository, as the header of `kamado ui` shows them. */
export interface GitInfo {
	/** The branch that is checked out; `null` for a detached HEAD. */
	readonly branch: string | null;
	/** The short hash of the commit that is checked out. */
	readonly sha: string;
}

/** How long `git` may take: the header must not hold up the screen, and the answer is not vital. */
const TIMEOUT_MS = 2000;

/** The most a name or a hash can be: a branch name is a few hundred bytes at most. */
const MAX_OUTPUT = 4096;

/**
 * Runs `git` in a directory and returns what it printed, or `null` when it failed for any
 * reason (no `git`, not a repository, no such ref, too slow).
 * @param cwd - The directory to run in
 * @param args - The arguments, fixed by the caller: nothing from a request goes in
 */
function run(cwd: string, args: readonly string[]): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(
			'git',
			args,
			{
				cwd,
				timeout: TIMEOUT_MS,
				maxBuffer: MAX_OUTPUT,
				windowsHide: true,
				// Only looks: it must not take the lock of a repository that a commit is using.
				env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
			},
			(error, stdout) => {
				resolve(error === null ? stdout.trim() : null);
			},
		);
	});
}

/**
 * The branch and the short commit hash of the repository a directory is in. `null` when there is
 * nothing to show: `git` is not installed, the directory is not in a repository, the repository
 * has no commit yet, or `git` took too long.
 *
 * It asks `git` and does not read `.git` itself: a worktree, `packed-refs`, a detached HEAD and
 * the newer ref storage are all `git`'s to resolve, and a hand-written reader would have to
 * follow each of them.
 * @param cwd - A directory of the repository (the one of the config file)
 * @example
 * ```ts
 * await readGit('/site'); // { branch: 'main', sha: '51df987' }
 * await readGit('/not-a-repository'); // null
 * ```
 */
export async function readGit(cwd: string): Promise<GitInfo | null> {
	// Asked together: the answer waits for the slower one, not for both one after the other.
	// `symbolic-ref` fails on a detached HEAD, which is a commit and no branch.
	const [sha, branch] = await Promise.all([
		run(cwd, ['rev-parse', '--short=7', 'HEAD']),
		run(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
	]);
	if (sha === null || sha === '') {
		return null;
	}
	return { branch: branch === null || branch === '' ? null : branch, sha };
}

/** How long an answer of `git` is kept: a switch of the branch shows within this time. */
const KEEP_MS = 1000;

/**
 * A reader of the repository of a directory that remembers its answer for a moment, so that
 * requests that come one after the other (a page turn, a search, a refresh) share one pair of
 * `git` processes and do not start them again each time. A request that comes while the answer
 * is being read gets that answer.
 * @param cwd - A directory of the repository (the one of the config file)
 * @param maxAgeMs - How long an answer is kept, in milliseconds
 * @param read - Reads the repository (`readGit`; another one in a test)
 * @example
 * ```ts
 * const reader = cachedReadGit('/site');
 * await reader(); // { branch: 'main', sha: '51df987' }
 * await reader(); // the same answer, `git` was not started again
 * ```
 */
export function cachedReadGit(
	cwd: string,
	maxAgeMs: number = KEEP_MS,
	read: (cwd: string) => Promise<GitInfo | null> = readGit,
): () => Promise<GitInfo | null> {
	let kept: { readonly at: number; readonly answer: Promise<GitInfo | null> } | undefined;
	return () => {
		const now = Date.now();
		if (kept === undefined || now - kept.at >= maxAgeMs) {
			kept = { at: now, answer: read(cwd) };
		}
		return kept.answer;
	};
}
