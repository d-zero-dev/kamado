import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { cachedReadGit, readGit } from './git.js';

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'kamado-git-'));
	// What the machine's own configuration says (signing, hooks) is not part of the test.
	vi.stubEnv('GIT_CONFIG_GLOBAL', devNull);
	vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});

afterEach(async () => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	await rm(dir, { recursive: true, force: true });
});

/**
 * Runs `git` in the test directory.
 * @param args - The arguments
 */
function git(...args: string[]): string {
	return execFileSync(
		'git',
		['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
		{ cwd: dir, encoding: 'utf8' },
	).trim();
}

describe('readGit', () => {
	test('is the branch and the short hash of the commit', async () => {
		git('init', '-q', '-b', 'feature/foo');
		git('commit', '-q', '--allow-empty', '-m', 'first');
		const sha = git('rev-parse', '--short=7', 'HEAD');
		expect(sha).toHaveLength(7);
		expect(await readGit(dir)).toEqual({ branch: 'feature/foo', sha });
	});

	test('is the hash alone for a detached HEAD', async () => {
		git('init', '-q', '-b', 'main');
		git('commit', '-q', '--allow-empty', '-m', 'first');
		git('checkout', '-q', '--detach');
		const sha = git('rev-parse', '--short=7', 'HEAD');
		expect(await readGit(dir)).toEqual({ branch: null, sha });
	});

	test('follows a switch of the branch', async () => {
		git('init', '-q', '-b', 'main');
		git('commit', '-q', '--allow-empty', '-m', 'first');
		git('switch', '-q', '-c', 'other');
		const info = await readGit(dir);
		expect(info?.branch).toBe('other');
	});

	test('is nothing in a directory that is not in a repository', async () => {
		// The temporary directory is not inside one; the ceiling makes sure.
		vi.stubEnv('GIT_CEILING_DIRECTORIES', path.dirname(dir));
		expect(await readGit(dir)).toBeNull();
	});

	test('is nothing in a repository that has no commit yet', async () => {
		git('init', '-q', '-b', 'main');
		expect(await readGit(dir)).toBeNull();
	});

	test('is nothing for a directory that is not there', async () => {
		expect(await readGit(path.join(dir, 'missing'))).toBeNull();
	});
});

describe('readGit that cannot be answered', () => {
	test('is nothing when `git` takes longer than the time it is given', async () => {
		// A `git` that never answers in time, first on the PATH.
		await writeFile(path.join(dir, 'git'), '#!/bin/sh\nexec sleep 10\n');
		await chmod(path.join(dir, 'git'), 0o755);
		vi.stubEnv('PATH', `${dir}${path.delimiter}${process.env['PATH'] ?? ''}`);
		const started = Date.now();
		expect(await readGit(dir)).toBeNull();
		expect(Date.now() - started).toBeLessThan(8000);
	}, 15_000);

	test('is nothing when `git` is not installed', async () => {
		vi.stubEnv('PATH', dir);
		expect(await readGit(dir)).toBeNull();
	});
});

describe('cachedReadGit', () => {
	const info = { branch: 'main', sha: '51df987' };

	test('shares one read between requests that come within the time', async () => {
		vi.useFakeTimers();
		const read = vi.fn(() => Promise.resolve(info));
		const reader = cachedReadGit('/s', 1000, read);
		expect(await reader()).toEqual(info);
		vi.advanceTimersByTime(999);
		expect(await reader()).toEqual(info);
		expect(read).toHaveBeenCalledTimes(1);
		expect(read).toHaveBeenCalledWith('/s');
	});

	test('reads again once the time is over, so that a switch of the branch shows', async () => {
		vi.useFakeTimers();
		const read = vi
			.fn<(cwd: string) => Promise<{ branch: string | null; sha: string } | null>>()
			.mockResolvedValueOnce(info)
			.mockResolvedValueOnce({ branch: 'other', sha: '51df987' });
		const reader = cachedReadGit('/s', 1000, read);
		await reader();
		vi.advanceTimersByTime(1000);
		expect(await reader()).toEqual({ branch: 'other', sha: '51df987' });
		expect(read).toHaveBeenCalledTimes(2);
	});

	test('gives a request that comes while the read is not over that read', async () => {
		let finish: (value: typeof info) => void = () => {};
		const read = vi.fn(
			() =>
				new Promise<typeof info>((resolve) => {
					finish = resolve;
				}),
		);
		const reader = cachedReadGit('/s', 1000, read);
		const first = reader();
		const second = reader();
		finish(info);
		expect(await first).toEqual(info);
		expect(await second).toEqual(info);
		expect(read).toHaveBeenCalledTimes(1);
	});
});
