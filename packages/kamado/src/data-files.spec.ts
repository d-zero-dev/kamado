import type { DataModule, DataPlan, RunOutcome } from './data-files.js';

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { DataFiles, RETRY_AFTER_FAILURE_MS } from './data-files.js';
import { stampOf } from './data-stamp.js';

let dir = '';
let clock = 1_000_000;
let outcomes: Record<string, RunOutcome[]> = {};
let runs: string[] = [];

/**
 * A run that answers what the test queued for the key, the last answer again and again.
 * @param file
 */
const run = (file: DataModule): Promise<RunOutcome> => {
	runs.push(file.key);
	const queue = outcomes[file.key] ?? [];
	const next = queue.length > 1 ? queue.shift() : queue[0];
	return Promise.resolve(next ?? { ok: false, message: 'nothing queued', reads: [] });
};

const done = (
	value: unknown,
	extra: { maxAge?: number | null; reads?: { path: string; stamp: string }[] } = {},
): RunOutcome => ({
	ok: true,
	value,
	reads: extra.reads ?? [],
	maxAge: extra.maxAge ?? null,
});

/**
 * @param keys - The keys of the data files; each is a file in the data directory
 */
function planOf(...keys: string[]): DataPlan {
	return {
		cacheDir: path.join(dir, 'cache'),
		dataDir: path.join(dir, 'data'),
		extensions: ['.ts'],
		modules: keys.map((key) => ({
			key,
			source: path.join(dir, 'data', `${key}.ts`),
			module: path.join(dir, `${key}.mjs`),
			sources: [path.join(dir, 'data', `${key}.ts`)],
		})),
	};
}

/**
 * @param plan - What the core says now
 * @param log - Collects the lines
 */
function open(plan: DataPlan, log: string[] = []): DataFiles {
	for (const module of plan.modules) {
		if (!existsSync(module.source)) {
			writeFileSync(module.source, 'export default 1;');
		}
	}
	return new DataFiles(plan, {
		root: dir,
		replan: () => plan,
		run,
		now: () => clock,
		verbose: (line) => log.push(line),
		warn: (line) => log.push(`WARN ${line}`),
	});
}

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'kamado-data-files-'));
	mkdirSync(path.join(dir, 'data'));
	clock = 1_000_000;
	outcomes = {};
	runs = [];
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe('a build', () => {
	test('runs every file once, concurrently, and gives the values to the core', async () => {
		outcomes = { a: [done(1)], b: [done({ n: 2 })] };
		const files = open(planOf('a', 'b'));

		await files.runAll();

		expect(runs.toSorted()).toEqual(['a', 'b']);
		expect(files.executed()).toEqual({ a: { value: 1 }, b: { value: { n: 2 } } });
	});

	test('fails with every file that failed, named, and does not soften it with an old value', async () => {
		outcomes = {
			a: [{ ok: false, message: 'no answer', reads: [] }],
			b: [{ ok: false, message: 'refused', reads: [] }],
			c: [done(1)],
		};
		const files = open(planOf('a', 'b', 'c'));
		// A value on the disk from an earlier run.
		const earlier = open(planOf('a'));
		outcomes['a'] = [done('old')];
		await earlier.runAll();
		outcomes['a'] = [{ ok: false, message: 'no answer', reads: [] }];

		await expect(files.runAll()).rejects.toThrow(/a\.ts: no answer\n {2}b\.ts: refused/);
		// The value that an earlier run left on the disk does not soften a build.
		expect(files.executed()['a']).toEqual({ error: 'a.ts: no answer' });
	});

	test('says what it did without the value, only the first characters of its hash', async () => {
		const log: string[] = [];
		outcomes = { a: [done({ token: 'secret-value' })] };
		const files = open(planOf('a'), log);

		await files.runAll();

		expect(log).toHaveLength(1);
		expect(log[0]).toMatch(/^data a: ran \(\d+ms, hash [0-9a-f]{8}\)$/);
		expect(log.join(',')).not.toContain('secret');
	});
});

describe('the dev server', () => {
	test('starts from the disk when nothing the file is made of or read changed', async () => {
		const read = path.join(dir, 'rates.csv');
		writeFileSync(read, 'x');
		outcomes = {
			a: [done(1, { maxAge: 60, reads: [{ path: read, stamp: await stampOf(read) }] })],
		};
		await open(planOf('a')).runAll();
		runs = [];
		const log: string[] = [];

		const files = open(planOf('a'), log);
		await files.start();

		expect(runs).toEqual([]);
		expect(files.executed()).toEqual({ a: { value: 1 } });
		expect(log[0]).toMatch(/^data a: cache \(60s of maxAge left, hash [0-9a-f]{8}\)$/);
	});

	test('runs the file when what it read changed, or it is older than its maxAge', async () => {
		const read = path.join(dir, 'rates.csv');
		writeFileSync(read, 'x');
		outcomes = {
			a: [done(1, { maxAge: 60, reads: [{ path: read, stamp: await stampOf(read) }] })],
		};
		await open(planOf('a')).runAll();

		writeFileSync(read, 'xyz');
		runs = [];
		outcomes = { a: [done(2, { maxAge: 60 })] };
		const changed = open(planOf('a'));
		await changed.start();
		expect(runs).toEqual(['a']);

		clock += 61_000;
		runs = [];
		const aged = open(planOf('a'));
		outcomes = { a: [done(3)] };
		await aged.start();
		expect(runs).toEqual(['a']);
	});

	test('refresh runs again only what is out of date and says whether the core must be told', async () => {
		const read = path.join(dir, 'rates.csv');
		writeFileSync(read, 'x');
		outcomes = {
			a: [done(1, { reads: [{ path: read, stamp: await stampOf(read) }] }), done(2)],
			b: [done('b', { maxAge: 10 })],
		};
		const files = open(planOf('a', 'b'));
		await files.runAll();
		runs = [];

		expect(await files.refresh()).toBe(false);
		expect(runs).toEqual([]);

		writeFileSync(read, 'changed');
		expect(await files.refresh()).toBe(true);
		expect(runs).toEqual(['a']);
		expect(files.executed()['a']).toEqual({ value: 2 });

		// Older than the maxAge, and it makes the same value: nothing to tell the core.
		clock += 11_000;
		runs = [];
		expect(await files.refresh()).toBe(false);
		expect(runs).toEqual(['b']);
	});

	test('requests that come together wait for one run', async () => {
		outcomes = { a: [done(1, { maxAge: 1 })] };
		const files = open(planOf('a'));
		await files.runAll();
		clock += 2000;
		runs = [];

		await Promise.all([files.refresh(), files.refresh(), files.refresh()]);

		expect(runs).toEqual(['a']);
	});

	test('a file that fails keeps its last value and is not run for every request', async () => {
		const log: string[] = [];
		outcomes = { a: [done(1, { maxAge: 100 })] };
		const files = open(planOf('a'), log);
		await files.runAll();
		clock += 101_000;
		outcomes = { a: [{ ok: false, message: 'down', reads: [] }] };

		expect(await files.refresh()).toBe(false);

		expect(files.executed()).toEqual({ a: { value: 1 } });
		expect(log.at(-1)).toBe('WARN data a: failed (a.ts): down; the last value is used');
		runs = [];
		clock += RETRY_AFTER_FAILURE_MS + 1;
		await files.refresh();
		expect(runs, 'not before its maxAge has passed again').toEqual([]);
	});

	test('a file that failed and has no value fails its readers, and is tried again soon', async () => {
		outcomes = { a: [{ ok: false, message: 'down', reads: [] }, done(5)] };
		const files = open(planOf('a'));
		await files.start();

		expect(files.executed()).toEqual({ a: { error: 'a.ts: down' } });

		clock += 1000;
		runs = [];
		await files.refresh();
		expect(runs, 'too early').toEqual([]);

		clock += RETRY_AFTER_FAILURE_MS;
		expect(await files.refresh()).toBe(true);
		expect(files.executed()).toEqual({ a: { value: 5 } });
	});

	test('a file added to the data directory is run, and one removed is forgotten', async () => {
		outcomes = { a: [done(1)], b: [done(2)] };
		let plan = planOf('a');
		const files = new DataFiles(plan, {
			root: dir,
			replan: () => plan,
			run,
			now: () => clock,
		});
		writeFileSync(plan.modules[0]!.source, 'x');
		await files.start();

		plan = planOf('a', 'b');
		for (const module of plan.modules) {
			writeFileSync(module.source, 'y');
		}
		expect(await files.refresh()).toBe(true);
		expect(Object.keys(files.executed())).toEqual(['a', 'b']);

		plan = planOf('b');
		rmSync(path.join(dir, 'data', 'a.ts'));
		expect(await files.refresh()).toBe(true);
		expect(Object.keys(files.executed())).toEqual(['b']);
	});

	test('a file it is made of that changes makes it run again', async () => {
		outcomes = { a: [done(1), done(2)] };
		const files = open(planOf('a'));
		await files.start();
		runs = [];

		const source = path.join(dir, 'data', 'a.ts');
		utimesSync(source, new Date(0), new Date(1000));
		await files.refresh();

		expect(runs).toEqual(['a']);
	});

	test('a cache file that is not what a run writes is not used, and does not stop the server', async () => {
		outcomes = { a: [done(1, { maxAge: 60 })] };
		const plan = planOf('a');
		await open(plan).runAll();
		writeFileSync(
			path.join(plan.cacheDir, 'data', 'a.json'),
			'{"version":1,"maxAge":null}',
		);
		runs = [];
		outcomes = { a: [done(2)] };

		const files = open(plan);
		await files.start();

		expect(runs).toEqual(['a']);
		expect(files.executed()).toEqual({ a: { value: 2 } });
	});

	test('a file that fails at the start with an old value on the disk is tried again after its maxAge', async () => {
		outcomes = { a: [done(1, { maxAge: 10 })] };
		await open(planOf('a')).runAll();
		clock += 11_000;
		outcomes = { a: [{ ok: false, message: 'down', reads: [] }, done(7)] };
		const files = open(planOf('a'));
		await files.start();
		expect(files.executed()).toEqual({ a: { value: 1 } });

		clock += 11_000;
		expect(await files.refresh()).toBe(true);

		expect(files.executed()).toEqual({ a: { value: 7 } });
	});

	test('a plan that cannot be made is said and tried again by the next request', async () => {
		const log: string[] = [];
		outcomes = { a: [done(1)] };
		let fails = true;
		const plan = planOf('a');
		const files = new DataFiles(plan, {
			root: dir,
			replan: () => {
				if (fails) {
					throw new Error('data/b.ts:1:1: syntax error');
				}
				return planOf('a', 'b');
			},
			run,
			now: () => clock,
			warn: (line) => log.push(line),
		});
		writeFileSync(plan.modules[0]!.source, 'x');
		await files.start();
		outcomes['b'] = [done(2)];
		writeFileSync(path.join(dir, 'data', 'b.ts'), 'y');

		expect(await files.refresh()).toBe(false);
		expect(log).toEqual(['data files: data/b.ts:1:1: syntax error']);

		fails = false;
		expect(await files.refresh()).toBe(true);
		expect(Object.keys(files.executed())).toEqual(['a', 'b']);
	});

	test('a request that comes while a run is going looks again when it is over', async () => {
		const read = path.join(dir, 'rates.csv');
		writeFileSync(read, 'x');
		let release: () => void = () => {};
		let first = true;
		const plan = planOf('a');
		writeFileSync(plan.modules[0]!.source, 'x');
		const files = new DataFiles(plan, {
			root: dir,
			now: () => clock,
			run: (file) => {
				runs.push(file.key);
				if (first) {
					first = false;
					return Promise.resolve(done(1, { reads: [{ path: read, stamp: 'old' }] }));
				}
				return new Promise((resolve) => {
					release = () => resolve(done(2));
				});
			},
		});
		await files.start();
		runs = [];

		const early = files.refresh();
		await new Promise((resolve) => setTimeout(resolve, 5));
		const late = files.refresh();
		release();
		await early;
		await new Promise((resolve) => setTimeout(resolve, 5));
		release();
		await late;

		expect(files.executed()).toEqual({ a: { value: 2 } });
	});

	test('a failure that is followed by the same value tells the core nothing', async () => {
		outcomes = {
			a: [done(1, { maxAge: 10 }), { ok: false, message: 'down', reads: [] }, done(1)],
		};
		const files = open(planOf('a'));
		await files.runAll();
		clock += 11_000;
		expect(await files.refresh()).toBe(false);
		clock += 11_000;

		expect(await files.refresh()).toBe(false);
	});

	test('a data file of the extensions the core names is looked for, and a type declaration is not', async () => {
		const plan = { ...planOf('a'), extensions: ['.ts', '.mjs'] };
		const files = open(plan);
		outcomes = { a: [done(1)] };
		await files.start();
		runs = [];

		writeFileSync(path.join(dir, 'data', 'types.d.ts'), 'export {};');
		expect(await files.refresh(), 'a declaration is not a data file').toBe(false);
		expect(runs).toEqual([]);
	});

	test('reload plans again and runs a file that the new plan has', async () => {
		outcomes = { a: [done(1)], b: [done(2)] };
		let plan = planOf('a');
		const files = new DataFiles(plan, {
			root: dir,
			replan: () => plan,
			run,
			now: () => clock,
		});
		writeFileSync(plan.modules[0]!.source, 'x');
		await files.start();

		plan = planOf('a', 'b');
		writeFileSync(plan.modules[1]!.source, 'y');
		await files.reload();

		expect(Object.keys(files.executed())).toEqual(['a', 'b']);
	});
});
