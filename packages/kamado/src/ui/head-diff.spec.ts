import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createHeadDiff } from './head-diff.js';

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'kamado-head-diff-'));
	vi.stubEnv('GIT_CONFIG_GLOBAL', devNull);
	vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/**
 * Runs `git` in the test directory.
 * @param args - The arguments
 */
function git(...args: string[]): string {
	return execFileSync(
		'git',
		[
			'-c',
			'user.name=Test',
			'-c',
			'user.email=test@example.com',
			// A commit must not start a clean-up that goes on after the test (it would meet the removal of the directory).
			'-c',
			'maintenance.auto=false',
			'-c',
			'gc.auto=0',
			...args,
		],
		{ cwd: dir, encoding: 'utf8' },
	).trim();
}

/**
 * Writes a file of the test repository.
 * @param rel - The path
 * @param content - What it holds
 */
async function write(rel: string, content: string): Promise<void> {
	await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
	await writeFile(path.join(dir, rel), content);
}

/**
 * The id git gives a file of this content.
 * @param content - What the file holds
 */
function blobId(content: string): string {
	const body = Buffer.from(content);
	return createHash('sha1')
		.update(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body]))
		.digest('hex');
}

/** A repository whose commit holds `src/a.html` as `OLD`. */
const OLD = '---\ntitle: Old\n---\n';
const NEW = '---\ntitle: New\n---\n';

/** Makes the repository, then changes the file. */
async function repository(): Promise<string> {
	git('init', '-q', '-b', 'main');
	await write('src/a.html', OLD);
	git('add', '.');
	git('commit', '-q', '-m', 'first');
	await write('src/a.html', NEW);
	await write('src/b.html', 'b');
	return git('rev-parse', 'HEAD');
}

/**
 * A core that lists the files of the repository and answers like the real one: it asks for the
 * text of a file the first time.
 * @param options - What it records
 * @param options.calls - Where the calls are written
 */
function fakeCore(options: {
	calls: { name: string; query: Record<string, unknown> }[];
}) {
	return {
		uiDiffFiles(_handle: string, query: string) {
			options.calls.push({ name: 'uiDiffFiles', query: JSON.parse(query) });
			return JSON.stringify({
				files: [
					{ path: 'src/a.html', blob: blobId(NEW) },
					{ path: 'src/b.html', blob: blobId('b') },
				],
				overrides: null,
			});
		},
		uiDiff(_handle: string, query: string) {
			const parsed = JSON.parse(query) as { head: Record<string, { text?: string }> };
			options.calls.push({ name: 'uiDiff', query: parsed });
			if (parsed.head['src/a.html']?.text === undefined) {
				return JSON.stringify({ need: ['src/a.html'] });
			}
			return JSON.stringify({
				version: 4,
				pages: { '/a.html': { meta: {} } },
				columns: [],
			});
		},
		uiEdit(_handle: string, edit: string) {
			const parsed = JSON.parse(edit) as {
				change: { head: Record<string, { text?: string }> };
			};
			options.calls.push({ name: 'uiEdit', query: parsed });
			if (parsed.change.head['src/a.html']?.text === undefined) {
				return JSON.stringify({ ok: false, code: 'need', need: ['src/a.html'] });
			}
			return JSON.stringify({ ok: true, version: 5 });
		},
	};
}

describe('createHeadDiff().diff', () => {
	test('tells the core what the commit holds, and gives it the text of what it asks for', async () => {
		const commit = await repository();
		const calls: { name: string; query: Record<string, unknown> }[] = [];
		const head = createHeadDiff({ cwd: dir, core: fakeCore({ calls }), handle: 'h1' });
		const answer = await head.diff(['/a.html', '/b.html']);
		expect(answer).toEqual({
			head: { oid: commit },
			version: 4,
			pages: { '/a.html': { meta: {} } },
			columns: [],
		});
		expect(calls.map((call) => call.name)).toEqual(['uiDiffFiles', 'uiDiff', 'uiDiff']);
		expect(calls[0]?.query).toEqual({ urls: ['/a.html', '/b.html'], format: 'sha1' });
		const first = calls[1]?.query as { head: Record<string, unknown> };
		// the file that is what the commit holds is told apart without its text; the other by its id
		expect(first.head).toEqual({
			'src/a.html': { oid: blobId(OLD) },
			'src/b.html': null,
		});
		const second = calls[2]?.query as { head: Record<string, unknown> };
		expect(second.head['src/a.html']).toEqual({ oid: blobId(OLD), text: OLD });
	});

	test('is nothing outside a repository, and does not ask the core', async () => {
		vi.stubEnv('GIT_CEILING_DIRECTORIES', path.dirname(dir));
		const calls: { name: string; query: Record<string, unknown> }[] = [];
		const head = createHeadDiff({ cwd: dir, core: fakeCore({ calls }), handle: 'h1' });
		expect(await head.diff(['/a.html'])).toBeNull();
		expect(calls).toEqual([]);
	});
});

describe('createHeadDiff().diff when the core asks for a file it was not told of', () => {
	test('gives it up as a file that is not compared, and answers', async () => {
		await repository();
		const calls: string[] = [];
		const core = {
			uiDiffFiles: () =>
				JSON.stringify({
					files: [{ path: 'src/a.html', blob: blobId(NEW) }],
					overrides: null,
				}),
			uiDiff(_handle: string, query: string) {
				const { head } = JSON.parse(query) as { head: Record<string, unknown> };
				calls.push(JSON.stringify(head));
				return head['src/other.html'] === 'skip'
					? JSON.stringify({ version: 1, pages: {}, columns: [] })
					: JSON.stringify({ need: ['src/other.html'] });
			},
			uiEdit: () => '{}',
		};
		const answer = await createHeadDiff({ cwd: dir, core, handle: 'h1' }).diff([
			'/a.html',
		]);
		expect(answer?.pages).toEqual({});
		expect(calls).toHaveLength(2);
	});
});

describe('createHeadDiff().diff when many files differ', () => {
	test('gives the core the text of all of them, in as many reads as it takes', async () => {
		git('init', '-q', '-b', 'main');
		const COUNT = 600;
		for (let index = 0; index < COUNT; index++) {
			await write(`src/p${index}.html`, `---\\ntitle: old${index}\\n---\\n`);
		}
		git('add', '.');
		git('commit', '-q', '-m', 'first');
		for (let index = 0; index < COUNT; index++) {
			await write(`src/p${index}.html`, `---\\ntitle: new${index}\\n---\\n`);
		}
		const files = Array.from({ length: COUNT }, (_, index) => ({
			path: `src/p${index}.html`,
			blob: blobId(`---\\ntitle: new${index}\\n---\\n`),
		}));
		let given = 0;
		const core = {
			uiDiffFiles: () => JSON.stringify({ files, overrides: null }),
			uiDiff(_handle: string, query: string) {
				const { head } = JSON.parse(query) as {
					head: Record<string, { text?: string } | null>;
				};
				const asked = files.filter((file) => head[file.path]?.text === undefined);
				if (asked.length > 0) {
					return JSON.stringify({ need: asked.map((file) => file.path) });
				}
				given = files.filter(
					(file, index) => head[file.path]?.text === `---\\ntitle: old${index}\\n---\\n`,
				).length;
				return JSON.stringify({ version: 1, pages: {}, columns: [] });
			},
			uiEdit: () => '{}',
		};
		const answer = await createHeadDiff({ cwd: dir, core, handle: 'h1' }).diff(['/']);
		expect(answer).not.toBeNull();
		expect(given).toBe(COUNT);
	});
});

describe('createHeadDiff().revert when the commit moves in the middle', () => {
	test('writes nothing when the commit changes after the files were looked at', async () => {
		await repository();
		const commit = git('rev-parse', 'HEAD');
		const calls: string[] = [];
		const core = {
			uiDiffFiles() {
				calls.push('uiDiffFiles');
				// the branch moves while the files are being read
				git('commit', '-q', '--allow-empty', '-m', 'moved');
				return JSON.stringify({
					files: [{ path: 'src/a.html', blob: blobId(NEW) }],
					overrides: null,
				});
			},
			uiDiff: () => '{}',
			uiEdit() {
				calls.push('uiEdit');
				return JSON.stringify({ ok: true });
			},
		};
		const result = await createHeadDiff({ cwd: dir, core, handle: 'h1' }).revert({
			url: '/a.html',
			expect: { input: 'x', sidecar: null, overrides: null },
			key: 'title',
			head: commit,
		});
		expect(result).toEqual({ kind: 'headMoved' });
		expect(calls).toEqual(['uiDiffFiles']);
	});
});

describe('createHeadDiff().revert', () => {
	const request = (commit: string) => ({
		url: '/a.html',
		expect: { input: 'x', sidecar: null, overrides: null },
		key: 'title',
		head: commit,
	});

	test('asks the core to put the key back, with the text of the commit it asked for', async () => {
		const commit = await repository();
		const calls: { name: string; query: Record<string, unknown> }[] = [];
		const head = createHeadDiff({ cwd: dir, core: fakeCore({ calls }), handle: 'h1' });
		expect(await head.revert(request(commit))).toEqual({
			kind: 'edit',
			result: { ok: true, version: 5 },
		});
		expect(calls.map((call) => call.name)).toEqual(['uiDiffFiles', 'uiEdit', 'uiEdit']);
		const last = calls[2]?.query as {
			url: string;
			expect: unknown;
			change: { op: string; key: string; head: Record<string, unknown> };
		};
		expect(last.url).toBe('/a.html');
		expect(last.expect).toEqual({ input: 'x', sidecar: null, overrides: null });
		expect(last.change.op).toBe('revert');
		expect(last.change.key).toBe('title');
		expect(last.change.head['src/a.html']).toEqual({ oid: blobId(OLD), text: OLD });
	});

	test('does not write when the commit is not the one the screen compared with', async () => {
		await repository();
		const calls: { name: string; query: Record<string, unknown> }[] = [];
		const head = createHeadDiff({ cwd: dir, core: fakeCore({ calls }), handle: 'h1' });
		expect(await head.revert(request('a'.repeat(40)))).toEqual({ kind: 'headMoved' });
		expect(calls).toEqual([]);
	});

	test('has no commit to go back to outside a repository', async () => {
		vi.stubEnv('GIT_CEILING_DIRECTORIES', path.dirname(dir));
		const calls: { name: string; query: Record<string, unknown> }[] = [];
		const head = createHeadDiff({ cwd: dir, core: fakeCore({ calls }), handle: 'h1' });
		expect(await head.revert(request('a'.repeat(40)))).toEqual({ kind: 'noHead' });
		expect(calls).toEqual([]);
	});
});
