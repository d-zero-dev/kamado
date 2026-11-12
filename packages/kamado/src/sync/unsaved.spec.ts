import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { findUnsaved } from './unsaved.js';

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'kamado-sync-unsaved-'));
	// What the machine's own configuration says (signing, hooks, ignore files) is not the test.
	vi.stubEnv('GIT_CONFIG_GLOBAL', devNull);
	vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});
afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(dir, { recursive: true, force: true });
});

/**
 *
 * @param {...any} args
 */
function git(...args: string[]): void {
	execFileSync(
		'git',
		['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
		{ cwd: dir },
	);
}

/**
 *
 * @param rel
 * @param text
 */
function write(rel: string, text: string): string {
	const file = path.join(dir, rel);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, text);
	return file;
}

/** A repository with a commit that holds `src/a.html` and `src/b.html`. */
function repository(): void {
	git('init', '-q', '-b', 'main');
	write('src/a.html', 'a\n');
	write('src/b.html', 'b\n');
	git('add', '-A');
	git('commit', '-q', '-m', 'first');
}

const inputDir = () => path.join(dir, 'src');

describe('findUnsaved', () => {
	test('has nothing to say about files that are committed as they are', async () => {
		repository();
		expect(
			await findUnsaved({
				cwd: dir,
				inputDir: inputDir(),
				files: [path.join(dir, 'src/a.html'), path.join(dir, 'src/b.html')],
			}),
		).toEqual({ unsaved: [], gitUnavailable: false });
	});

	test('names a file that was changed after the commit, relative to dir.input', async () => {
		repository();
		write('src/a.html', 'changed\n');
		expect(
			await findUnsaved({
				cwd: dir,
				inputDir: inputDir(),
				files: [path.join(dir, 'src/a.html'), path.join(dir, 'src/b.html')],
			}),
		).toEqual({ unsaved: ['a.html'], gitUnavailable: false });
	});

	test('names a file that is new and not committed (git cannot bring it back)', async () => {
		repository();
		const fresh = write('src/new/index.html', 'new\n');
		expect(await findUnsaved({ cwd: dir, inputDir: inputDir(), files: [fresh] })).toEqual(
			{ unsaved: ['new/index.html'], gitUnavailable: false },
		);
	});

	test('names a file that git ignores (git cannot bring it back either)', async () => {
		repository();
		write('.gitignore', 'src/ignored.html\n');
		const ignored = write('src/ignored.html', 'x\n');
		expect(
			await findUnsaved({ cwd: dir, inputDir: inputDir(), files: [ignored] }),
		).toEqual({ unsaved: ['ignored.html'], gitUnavailable: false });
	});

	test('names a file that was deleted and not committed', async () => {
		repository();
		rmSync(path.join(dir, 'src/a.html'));
		expect(
			await findUnsaved({
				cwd: dir,
				inputDir: inputDir(),
				files: [path.join(dir, 'src/a.html')],
			}),
		).toEqual({ unsaved: ['a.html'], gitUnavailable: false });
	});

	test('looks only at the files it is given', async () => {
		repository();
		write('src/b.html', 'changed\n');
		expect(
			await findUnsaved({
				cwd: dir,
				inputDir: inputDir(),
				files: [path.join(dir, 'src/a.html')],
			}),
		).toEqual({ unsaved: [], gitUnavailable: false });
	});

	test('takes names that look like a pathspec for what they are', async () => {
		repository();
		const odd = write('src/:(exclude)x.html', 'x\n');
		const star = write('src/*.html', 'y\n');
		const result = await findUnsaved({
			cwd: dir,
			inputDir: inputDir(),
			files: [odd, star],
		});
		expect(result.unsaved.toSorted()).toEqual(['*.html', ':(exclude)x.html']);
	});

	test('has no file to look at', async () => {
		repository();
		expect(await findUnsaved({ cwd: dir, inputDir: inputDir(), files: [] })).toEqual({
			unsaved: [],
			gitUnavailable: false,
		});
	});

	test('says git cannot tell when the directory is not in a repository', async () => {
		const file = write('src/a.html', 'a\n');
		expect(await findUnsaved({ cwd: dir, inputDir: inputDir(), files: [file] })).toEqual({
			unsaved: [],
			gitUnavailable: true,
		});
	});

	test('says git cannot tell when nothing is committed yet', async () => {
		git('init', '-q', '-b', 'main');
		const file = write('src/a.html', 'a\n');
		expect(await findUnsaved({ cwd: dir, inputDir: inputDir(), files: [file] })).toEqual({
			unsaved: [],
			gitUnavailable: true,
		});
	});

	test('says git cannot tell when git is not there', async () => {
		repository();
		vi.stubEnv('PATH', '');
		const file = path.join(dir, 'src/a.html');
		expect(await findUnsaved({ cwd: dir, inputDir: inputDir(), files: [file] })).toEqual({
			unsaved: [],
			gitUnavailable: true,
		});
	});

	test('names a file whose change is staged and not committed, and a rename that is staged', async () => {
		repository();
		write('src/a.html', 'staged\n');
		git('add', 'src/a.html');
		git('mv', 'src/b.html', 'src/c.html');
		const result = await findUnsaved({
			cwd: dir,
			inputDir: inputDir(),
			files: [path.join(dir, 'src/a.html'), path.join(dir, 'src/c.html')],
		});
		expect(result.unsaved.toSorted()).toEqual(['a.html', 'c.html']);
		expect(result.gitUnavailable).toBe(false);
	});

	test('works from a directory inside the repository, and names the files relative to dir.input', async () => {
		git('init', '-q', '-b', 'main');
		write('site/src/a.html', 'a\n');
		write('site/src/b.html', 'b\n');
		git('add', '-A');
		git('commit', '-q', '-m', 'first');
		write('site/src/a.html', 'changed\n');
		expect(
			await findUnsaved({
				cwd: path.join(dir, 'site'),
				inputDir: path.join(dir, 'site', 'src'),
				files: [path.join(dir, 'site/src/a.html'), path.join(dir, 'site/src/b.html')],
			}),
		).toEqual({ unsaved: ['a.html'], gitUnavailable: false });
	});

	test('finds a file that changed in the last of many groups of files', async () => {
		git('init', '-q', '-b', 'main');
		const name = (i: number) =>
			`src/${'a-long-directory-name-to-fill-the-line-'.repeat(2)}${i}/index.html`;
		const count = 3000;
		for (let i = 0; i < count; i += 1) {
			write(name(i), 'x\n');
		}
		git('add', '-A');
		git('commit', '-q', '-m', 'many');
		write(name(count - 1), 'changed\n');
		write(name(0), 'changed\n');
		const files = Array.from({ length: count }, (_, i) => path.join(dir, name(i)));
		const result = await findUnsaved({ cwd: dir, inputDir: inputDir(), files });
		expect(result.unsaved).toHaveLength(2);
		expect(result.unsaved).toContain(name(count - 1).slice('src/'.length));
		expect(result.unsaved).toContain(name(0).slice('src/'.length));
	}, 60_000);

	test('handles many files, in as many calls as the command line needs', async () => {
		repository();
		const files = Array.from({ length: 20_000 }, (_, i) =>
			path.join(
				dir,
				'src',
				`a-very-long-directory-name-to-fill-the-line-${i}`,
				'index.html',
			),
		);
		const result = await findUnsaved({ cwd: dir, inputDir: inputDir(), files });
		expect(result).toEqual({ unsaved: [], gitUnavailable: false });
	});
});
