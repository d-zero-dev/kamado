import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
	MAX_FILE_BYTES,
	readHeadOid,
	readHeadStates,
	readHeadTexts,
	readObjectFormat,
} from './head.js';

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'kamado-head-'));
	// What the machine's own configuration says (signing, hooks, line endings) is not part of the
	// test.
	vi.stubEnv('GIT_CONFIG_GLOBAL', devNull);
	vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});

afterEach(async () => {
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

/**
 * Writes a file of the test repository.
 * @param rel - The path, relative to the repository
 * @param content - What it holds
 */
async function write(rel: string, content: string | Buffer): Promise<void> {
	await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
	await writeFile(path.join(dir, rel), content);
}

/**
 * The id git gives a file of this content.
 * @param content - What the file holds
 * @param algorithm - The hash of the repository
 */
function blobId(content: string | Buffer, algorithm: 'sha1' | 'sha256' = 'sha1'): string {
	const body = Buffer.from(content);
	return createHash(algorithm)
		.update(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]))
		.digest('hex');
}

/** A repository with one commit, which holds `a.txt`, `b/c.txt` and a `.gitignore`. */
async function commitOne(): Promise<string> {
	git('init', '-q', '-b', 'main');
	await write('a.txt', 'one\n');
	await write('b/c.txt', 'same\n');
	await write('.gitignore', 'ignored.txt\n');
	git('add', '.');
	git('commit', '-q', '-m', 'first');
	return git('rev-parse', 'HEAD');
}

describe('readHeadOid', () => {
	test('is the id in full of the commit that is checked out', async () => {
		const oid = await commitOne();
		expect(oid).toMatch(/^[\da-f]{40}$/u);
		expect(await readHeadOid(dir)).toBe(oid);
	});

	test('follows a new commit', async () => {
		const first = await commitOne();
		git('commit', '-q', '--allow-empty', '-m', 'second');
		const second = await readHeadOid(dir);
		expect(second).not.toBe(first);
		expect(second).toBe(git('rev-parse', 'HEAD'));
	});

	test('is nothing for a repository with no commit, and for a directory that is not in one', async () => {
		git('init', '-q', '-b', 'main');
		expect(await readHeadOid(dir)).toBeNull();
		vi.stubEnv('GIT_CEILING_DIRECTORIES', path.dirname(dir));
		const other = await mkdtemp(path.join(tmpdir(), 'kamado-head-none-'));
		try {
			expect(await readHeadOid(other)).toBeNull();
			expect(await readHeadOid(path.join(other, 'missing'))).toBeNull();
		} finally {
			await rm(other, { recursive: true, force: true });
		}
	});
});

describe('readObjectFormat', () => {
	test('is sha1 for an ordinary repository', async () => {
		git('init', '-q', '-b', 'main');
		expect(await readObjectFormat(dir)).toBe('sha1');
	});

	test('is sha256 for a repository made with that format', async () => {
		git('init', '-q', '-b', 'main', '--object-format=sha256');
		expect(await readObjectFormat(dir)).toBe('sha256');
	});
});

describe('readHeadStates', () => {
	test('tells the files that are what the commit holds, that differ, and that it does not have', async () => {
		const commit = await commitOne();
		await write('a.txt', 'two\n');
		await write('new.txt', 'new\n');
		const states = await readHeadStates(
			dir,
			commit,
			[
				{ path: 'a.txt', blob: blobId('two\n') },
				{ path: 'b/c.txt', blob: blobId('same\n') },
				{ path: 'new.txt', blob: blobId('new\n') },
				{ path: 'gone.txt', blob: null },
			],
			null,
		);
		expect(states).toEqual(
			new Map([
				['a.txt', { oid: blobId('one\n') }],
				['b/c.txt', 'same'],
				['new.txt', null],
				['gone.txt', null],
			]),
		);
	});

	test('tells a file git does not track from one that is added', async () => {
		const commit = await commitOne();
		await write('ignored.txt', 'x\n');
		await write('added.txt', 'y\n');
		const states = await readHeadStates(
			dir,
			commit,
			[
				{ path: 'ignored.txt', blob: blobId('x\n') },
				{ path: 'added.txt', blob: blobId('y\n') },
			],
			null,
		);
		expect(states?.get('ignored.txt')).toBe('ignored');
		expect(states?.get('added.txt')).toBeNull();
	});

	test('does not call a file that is staged and not committed ignored', async () => {
		const commit = await commitOne();
		await write('staged.txt', 'z\n');
		git('add', 'staged.txt');
		const states = await readHeadStates(
			dir,
			commit,
			[{ path: 'staged.txt', blob: blobId('z\n') }],
			null,
		);
		expect(states?.get('staged.txt')).toBeNull();
	});

	test('takes paths with spaces and characters that are not ASCII', async () => {
		git('init', '-q', '-b', 'main');
		await write('my page/ü 日本語.html', 'old\n');
		git('add', '.');
		git('commit', '-q', '-m', 'first');
		const commit = git('rev-parse', 'HEAD');
		const states = await readHeadStates(
			dir,
			commit,
			[{ path: 'my page/ü 日本語.html', blob: blobId('new\n') }],
			null,
		);
		expect(states?.get('my page/ü 日本語.html')).toEqual({ oid: blobId('old\n') });
	});

	test('does not compare what is not a file, or a file that is too large', async () => {
		git('init', '-q', '-b', 'main');
		const large = Buffer.alloc(MAX_FILE_BYTES + 1, 0x61);
		await write('large.txt', large);
		await write('big-overrides.json', large);
		await write('dir/x.txt', 'x\n');
		git('add', '.');
		git('commit', '-q', '-m', 'first');
		const commit = git('rev-parse', 'HEAD');
		const states = await readHeadStates(
			dir,
			commit,
			[
				{ path: 'large.txt', blob: blobId('other') },
				{ path: 'big-overrides.json', blob: blobId('other') },
				{ path: 'dir', blob: null },
			],
			'big-overrides.json',
		);
		expect(states?.get('large.txt')).toBe('skip');
		// `pages.overrides` is one file for the whole site: it is as large as the site is
		expect(states?.get('big-overrides.json')).toEqual({ oid: blobId(large) });
		expect(states?.get('dir')).toBe('skip');
	});

	test('is nothing for a commit that is not an id in full, and when git cannot be asked', async () => {
		await commitOne();
		const files = [{ path: 'a.txt', blob: blobId('one\n') }];
		expect(await readHeadStates(dir, 'HEAD', files, null)).toBeNull();
		expect(await readHeadStates(dir, '--help', files, null)).toBeNull();
		expect(
			await readHeadStates(path.join(dir, 'missing'), 'a'.repeat(40), files, null),
		).toBeNull();
		expect(await readHeadStates(dir, 'a'.repeat(40), [], null)).toEqual(new Map());
	});

	test('reads the paths from the directory it is run in, when that is not the top of the repository', async () => {
		git('init', '-q', '-b', 'main');
		await write('packages/site/src/a.txt', 'one\n');
		await write('packages/site/.gitignore', 'ignored.txt\n');
		await write('top.txt', 'top\n');
		git('add', '.');
		git('commit', '-q', '-m', 'first');
		const commit = git('rev-parse', 'HEAD');
		await write('packages/site/src/a.txt', 'two\n');
		await write('packages/site/ignored.txt', 'x\n');
		await write('packages/site/new.txt', 'y\n');
		const states = await readHeadStates(
			path.join(dir, 'packages', 'site'),
			commit,
			[
				{ path: 'src/a.txt', blob: blobId('two\n') },
				{ path: 'ignored.txt', blob: blobId('x\n') },
				{ path: 'new.txt', blob: blobId('y\n') },
			],
			null,
		);
		expect(states).toEqual(
			new Map([
				['src/a.txt', { oid: blobId('one\n') }],
				['ignored.txt', 'ignored'],
				['new.txt', null],
			]),
		);
	});

	test('reads a file above the directory it is run in, and does not ask about one outside the repository', async () => {
		git('init', '-q', '-b', 'main');
		await write('site/keep.txt', 'k\n');
		await write('content/a.txt', 'one\n');
		git('add', '.');
		git('commit', '-q', '-m', 'first');
		const commit = git('rev-parse', 'HEAD');
		await write('content/a.txt', 'two\n');
		const states = await readHeadStates(
			path.join(dir, 'site'),
			commit,
			[
				{ path: '../content/a.txt', blob: blobId('two\n') },
				// above the top of the repository: not in it, and not for git to be asked about
				{ path: '../../outside.txt', blob: blobId('x') },
			],
			null,
		);
		expect(states).toEqual(
			new Map([
				['../content/a.txt', { oid: blobId('one\n') }],
				['../../outside.txt', 'skip'],
			]),
		);
	});

	test('answers for many files that are not in the commit, with long paths', async () => {
		await commitOne();
		const commit = git('rev-parse', 'HEAD');
		const files = Array.from({ length: 300 }, (_, index) => ({
			// The answer for an object that is not there repeats what was asked: the room it needs
			// is more than a short line for each.
			path: `${'long-directory-name/'.repeat(5)}page-${index}.html`,
			blob: blobId(`page ${index}`),
		}));
		const states = await readHeadStates(dir, commit, files, null);
		expect(states?.size).toBe(300);
		expect([...(states?.values() ?? [])].every((state) => state === null)).toBe(true);
	});

	test('reads the commit it is told and not the one that is checked out by then', async () => {
		const first = await commitOne();
		await write('a.txt', 'two\n');
		git('commit', '-q', '-a', '-m', 'second');
		const states = await readHeadStates(
			dir,
			first,
			[{ path: 'a.txt', blob: blobId('two\n') }],
			null,
		);
		expect(states?.get('a.txt')).toEqual({ oid: blobId('one\n') });
	});
});

describe('readHeadTexts', () => {
	test('reads the text of blobs by their ids', async () => {
		await commitOne();
		const oids = [blobId('one\n'), blobId('same\n')];
		const texts = await readHeadTexts(dir, oids);
		expect(texts).toEqual(
			new Map([
				[oids[0], 'one\n'],
				[oids[1], 'same\n'],
			]),
		);
	});

	test('keeps the line breaks and the characters of a text', async () => {
		git('init', '-q', '-b', 'main');
		const text = '---\r\ntitle: 日本語\r\n---\r\n\r\n';
		await write('p.html', text);
		await write('q.html', '');
		git('add', '.');
		git('commit', '-q', '-m', 'first');
		const texts = await readHeadTexts(dir, [blobId(text), blobId('')]);
		expect(texts?.get(blobId(text))).toBe(text);
		expect(texts?.get(blobId(''))).toBe('');
	});

	test('is nothing for a blob that is not UTF-8, and for one that is not there', async () => {
		git('init', '-q', '-b', 'main');
		const binary = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
		await write('bin.dat', binary);
		await write('after.txt', 'after\n');
		git('add', '.');
		git('commit', '-q', '-m', 'first');
		const missing = 'b'.repeat(40);
		const texts = await readHeadTexts(dir, [blobId(binary), missing, blobId('after\n')]);
		expect(texts?.get(blobId(binary))).toBeNull();
		expect(texts?.get(missing)).toBeNull();
		// what follows is read from the right place
		expect(texts?.get(blobId('after\n'))).toBe('after\n');
	});

	test('takes no id that is not one, and is empty for none', async () => {
		await commitOne();
		expect(await readHeadTexts(dir, [])).toEqual(new Map());
		expect(await readHeadTexts(dir, ['HEAD:a.txt', '--help'])).toEqual(new Map());
	});

	test('is nothing when the text is more than it may be', async () => {
		git('init', '-q', '-b', 'main');
		const large = 'a'.repeat(1000);
		await write('large.txt', large);
		git('add', '.');
		git('commit', '-q', '-m', 'first');
		expect(await readHeadTexts(dir, [blobId(large)], 100)).toBeNull();
		const enough = await readHeadTexts(dir, [blobId(large)], 1000);
		expect(enough?.get(blobId(large))).toBe(large);
	});
});
