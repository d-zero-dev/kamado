import type { SyncState } from '../types.js';

import { describe, expect, test } from 'vitest';

import { followSync, MAX_FAILURES, POLL_MS, type FollowDeps } from './sync-run.js';

/**
 *
 * @param over
 */
function state(over: Partial<SyncState>): SyncState {
	return {
		id: 'id-1',
		name: 'x',
		status: 'running',
		log: [],
		next: 0,
		dropped: 0,
		...over,
	};
}

/**
 * A follow over the answers given in order; an `Error` in the list is a request that fails.
 * @param answers
 * @param over
 */
function setup(answers: (SyncState | Error)[], over: Partial<FollowDeps> = {}) {
	const asked: number[] = [];
	const slept: number[] = [];
	const seen: SyncState[] = [];
	const controller = new AbortController();
	let i = 0;
	const deps: FollowDeps = {
		fetchState: (after) => {
			asked.push(after);
			const answer = answers[Math.min(i, answers.length - 1)]!;
			i += 1;
			return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
		},
		isFatal: () => false,
		sleep: (ms) => {
			slept.push(ms);
			return Promise.resolve();
		},
		onState: (s) => seen.push(s),
		signal: controller.signal,
		...over,
	};
	return { deps, asked, slept, seen, controller };
}

describe('followSync', () => {
	test('asks until the sync has ended, from where the log was read to, and waits between', async () => {
		const { deps, asked, slept, seen } = setup([
			state({ log: [{ type: 'info', message: 'one' }], next: 1 }),
			state({ log: [{ type: 'info', message: 'two' }], next: 2 }),
			state({ status: 'nochange', next: 2 }),
		]);
		const followed = await followSync(deps);
		expect(followed).toMatchObject({ kind: 'ended', state: { status: 'nochange' } });
		expect(asked).toEqual([0, 1, 2]);
		expect(slept).toEqual([POLL_MS, POLL_MS]);
		expect(seen).toHaveLength(3);
	});

	test('keeps the log whole across the answers', async () => {
		const logs: string[][] = [];
		const { deps } = setup(
			[
				state({ log: [{ type: 'info', message: 'one' }], next: 1 }),
				state({ status: 'review', log: [{ type: 'warn', message: 'two' }], next: 2 }),
			],
			{ onState: (_s, log) => logs.push(log.lines.map((l) => l.message)) },
		);
		await followSync(deps);
		expect(logs).toEqual([['one'], ['one', 'two']]);
	});

	test('asks again after an answer that fails, and counts the failures that come in a row', async () => {
		const { deps, slept } = setup([
			new Error('busy'),
			state({}),
			new Error('busy'),
			new Error('busy'),
			state({ status: 'failed' }),
		]);
		const followed = await followSync(deps);
		// one failure, an answer, two failures, an answer: never MAX_FAILURES in a row
		expect(followed).toMatchObject({ kind: 'ended', state: { status: 'failed' } });
		expect(slept.length).toBe(4);
	});

	test('is lost after as many failures in a row as it allows', async () => {
		const { deps, asked } = setup([new Error('down')]);
		const followed = await followSync(deps);
		expect(followed.kind).toBe('lost');
		expect(asked).toHaveLength(MAX_FAILURES);
	});

	test('is lost at once when the sync is not there', async () => {
		const { deps, asked } = setup([new Error('unknown')], { isFatal: () => true });
		const followed = await followSync(deps);
		expect(followed.kind).toBe('lost');
		expect(asked).toHaveLength(1);
	});

	test('stops without a word when it is aborted, while it waits and while it asks', async () => {
		const first = setup([state({})]);
		first.deps = { ...first.deps };
		const waiting = followSync({
			...first.deps,
			sleep: () => {
				first.controller.abort();
				return Promise.resolve();
			},
		});
		expect(await waiting).toEqual({ kind: 'aborted' });
		const second = setup([new Error('x')]);
		const asking = followSync({
			...second.deps,
			fetchState: () => {
				second.controller.abort();
				return Promise.reject(new Error('aborted'));
			},
		});
		expect(await asking).toEqual({ kind: 'aborted' });
		const third = setup([state({})]);
		const late = followSync({
			...third.deps,
			fetchState: () => {
				third.controller.abort();
				return Promise.resolve(state({ status: 'review' }));
			},
		});
		expect(await late).toEqual({ kind: 'aborted' });
	});

	test('does not take an answer that is not newer for more of the log', async () => {
		const { deps, seen } = setup([
			state({ log: [{ type: 'info', message: 'one' }], next: 1 }),
			state({ log: [{ type: 'info', message: 'one' }], next: 1 }),
			state({ status: 'nochange', next: 1 }),
		]);
		const lines: number[] = [];
		await followSync({ ...deps, onState: (_s, log) => lines.push(log.lines.length) });
		expect(lines).toEqual([1, 1, 1]);
		expect(seen).toHaveLength(0);
	});
});
