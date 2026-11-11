import type { GitInfo } from '../types.js';

/**
 * The text of the header for the repository of the site: `branch @ sha`, or the commit alone
 * when no branch is checked out (a detached HEAD). Nothing when there is nothing to show.
 * @param git - What the server answered (`null` when the site is not in a repository)
 * @example
 * ```ts
 * gitLabel({ branch: 'main', sha: '51df987' }); // 'main @ 51df987'
 * gitLabel({ branch: null, sha: '51df987' }); // '51df987'
 * gitLabel(null); // ''
 * ```
 */
export function gitLabel(git: GitInfo | null): string {
	if (git === null) {
		return '';
	}
	return git.branch === null ? git.sha : `${git.branch} @ ${git.sha}`;
}
