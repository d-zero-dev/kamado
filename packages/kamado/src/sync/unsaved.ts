/**
 * Which of the files a sync takes from the place they are in git cannot bring back (RFC §14.2,
 * "同期"). The operation of a sync is protected by git: the person looks at `git diff` and
 * resets what they do not want. A file with changes that are not committed, a new file that was
 * never committed, and a file git ignores are the ones git cannot give back, so those are told
 * before anything is removed, made virtual or moved.
 *
 * Why `git` is asked and `.git` is not read: a worktree, `packed-refs` and the newer ref storage
 * are git's to resolve (the same reason `git.ts` gives). Why the files go in groups, after `--`,
 * with `--literal-pathspecs`: a sync can touch tens of thousands of files, which do not fit on one
 * command line (`git status` takes no list of paths on its standard input), and a page file named
 * like a pathspec (`:(exclude)x.html`, `*.html`) is a file name and not a rule. Nothing from a script
 * is ever an argument but a path after `--`: `execFile` is not a shell, and the other arguments are
 * fixed.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';

/** How long one `git status` may take: a status of a few thousand paths of a big repository. */
const STATUS_TIMEOUT_MS = 30_000;

/**
 * How long a question of one line may take (is there a commit, where is the top of the
 * repository): `git` answers at once, and a repository that does not is not one to wait for.
 */
const ASK_TIMEOUT_MS = 10_000;

/** The most a question of one line can answer: a hash, or a path. */
const ASK_MAX_BYTES = 1024 * 1024;

/**
 * The most a `git status` of one group of paths can print: the paths of that group that have
 * changes, ignored files included, which can be all of them (about 200 KB of paths in a group).
 * Far above that, so that an answer is not cut in the middle of a path.
 */
const STATUS_MAX_BYTES = 256 * 1024 * 1024;

/**
 * The most bytes of paths for one `git status`: below the limit of a command line (about 1 MB of
 * arguments and environment on macOS, 32,767 characters on Windows), so that no group is refused.
 */
const GROUP_BYTES = process.platform === 'win32' ? 20_000 : 200_000;

/** How many groups run at once. */
const GROUPS_AT_ONCE = 4;

/** What {@link findUnsaved} takes. */
export interface UnsavedRequest {
	/** The directory of the config file: where `git` is run. */
	readonly cwd: string;
	/** The absolute `dir.input`: the names given back are relative to it. */
	readonly inputDir: string;
	/** The absolute paths of the files a sync takes from their place. */
	readonly files: readonly string[];
}

/** What {@link findUnsaved} gives back. */
export interface Unsaved {
	/** The files git cannot bring back, relative to `dir.input`, in the order `git` lists them. */
	readonly unsaved: readonly string[];
	/** `true` when git could not tell: then no file is known to be safe. */
	readonly gitUnavailable: boolean;
}

/** The environment of a call: looks only, so it does not take the lock of a repository a commit is using. */
const gitEnv = () => ({ ...process.env, GIT_OPTIONAL_LOCKS: '0' });

/**
 * Runs `git` and returns what it printed, or `null` when it failed for any reason.
 * @param cwd - Where to run it
 * @param args - Its arguments, fixed by the caller
 */
function ask(cwd: string, args: readonly string[]): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(
			'git',
			args,
			{
				cwd,
				timeout: ASK_TIMEOUT_MS,
				maxBuffer: ASK_MAX_BYTES,
				windowsHide: true,
				env: gitEnv(),
			},
			(error, stdout) => {
				resolve(error === null ? stdout : null);
			},
		);
	});
}

/**
 * Cuts the files into groups that fit on a command line.
 * @param files - The files
 */
function groupsOf(files: readonly string[]): string[][] {
	const groups: string[][] = [];
	let group: string[] = [];
	let bytes = 0;
	for (const file of files) {
		const size = Buffer.byteLength(file) + 1;
		if (group.length > 0 && bytes + size > GROUP_BYTES) {
			groups.push(group);
			group = [];
			bytes = 0;
		}
		group.push(file);
		bytes += size;
	}
	if (group.length > 0) {
		groups.push(group);
	}
	return groups;
}

/**
 * Runs `git status` for a group of files.
 * @param cwd - Where to run it
 * @param files - The files, after `--`
 * @returns What `git status --porcelain -z` printed, or `null` when it failed
 */
function status(cwd: string, files: readonly string[]): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(
			'git',
			[
				'--literal-pathspecs',
				'status',
				'--porcelain=v1',
				'-z',
				'--untracked-files=all',
				'--ignored',
				'--',
				...files,
			],
			{
				cwd,
				timeout: STATUS_TIMEOUT_MS,
				maxBuffer: STATUS_MAX_BYTES,
				windowsHide: true,
				env: gitEnv(),
			},
			(error, stdout) => {
				resolve(error === null ? stdout : null);
			},
		);
	});
}

/**
 * Runs `git status` for every group, a few at a time.
 * @param cwd - Where to run it
 * @param files - Every file
 * @returns What each group printed, or `null` when any failed
 */
async function statusOf(cwd: string, files: readonly string[]): Promise<string[] | null> {
	const groups = groupsOf(files);
	const outputs: string[] = [];
	let failed = false;
	let next = 0;
	const worker = async (): Promise<void> => {
		while (!failed && next < groups.length) {
			const group = groups[next]!;
			next += 1;
			const output = await status(cwd, group);
			if (output === null) {
				failed = true;
			} else {
				outputs.push(output);
			}
		}
	};
	await Promise.all(Array.from({ length: GROUPS_AT_ONCE }, worker));
	return failed ? null : outputs;
}

/**
 * Finds the files git cannot bring back among the files a sync takes from their place.
 * @param request - Where git is asked, the directory the names are relative to, and the files
 * @returns The files, or that git could not tell
 * @example
 * ```ts
 * const { unsaved, gitUnavailable } = await findUnsaved({
 * 	cwd: '/site',
 * 	inputDir: '/site/src',
 * 	files: ['/site/src/about/index.html'],
 * });
 * // { unsaved: ['about/index.html'], gitUnavailable: false }
 * ```
 */
export async function findUnsaved(request: UnsavedRequest): Promise<Unsaved> {
	const { cwd, inputDir, files } = request;
	const head = await ask(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
	if (head === null) {
		return { unsaved: [], gitUnavailable: true };
	}
	if (files.length === 0) {
		return { unsaved: [], gitUnavailable: false };
	}
	const prefix = await ask(cwd, ['rev-parse', '--show-prefix']);
	const outputs = prefix === null ? null : await statusOf(cwd, files);
	if (prefix === null || outputs === null) {
		return { unsaved: [], gitUnavailable: true };
	}
	// Each entry is `XY path`, and a rename or a copy is followed by the path it came from.
	// The paths are relative to the top of the repository; the files were given as the caller
	// names them (under `cwd`), so the prefix of `cwd` is taken off.
	const top = prefix.trim();
	const wanted = new Set(files);
	const unsaved: string[] = [];
	const entries = outputs.flatMap((output) => output.split('\0'));
	for (let i = 0; i < entries.length; i += 1) {
		const entry = entries[i]!;
		if (entry.length < 4) {
			continue;
		}
		const code = new Set(entry.slice(0, 2));
		const given = entry.slice(3);
		if (code.has('R') || code.has('C')) {
			i += 1;
		}
		const relative = top === '' ? given : path.posix.relative(top, given);
		const absolute = path.join(cwd, ...relative.split('/'));
		if (wanted.has(absolute)) {
			unsaved.push(path.relative(inputDir, absolute).split(path.sep).join('/'));
		}
	}
	return { unsaved, gitUnavailable: false };
}
