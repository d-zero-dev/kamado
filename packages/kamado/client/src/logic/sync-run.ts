import type { SyncState } from '../types.js';
import type { HeldLog } from './sync.js';

import { isFinished, mergeLog, NO_LOG } from './sync.js';

/** How often the state of a sync is asked for while its script runs, in milliseconds. */
export const POLL_MS = 300;

/**
 * How many answers in a row may fail before the screen gives up: one request that does not come
 * (a server that is busy, a connection that dropped) is not a sync that was lost.
 */
export const MAX_FAILURES = 3;

/** What {@link followSync} needs from its surroundings. */
export interface FollowDeps {
	/** Asks the server how the sync stands, and for the log from `after` on. */
	readonly fetchState: (after: number, signal: AbortSignal) => Promise<SyncState>;
	/** Says whether an error is the server's answer that the sync is not there (no retry helps). */
	readonly isFatal: (error: unknown) => boolean;
	/** Waits; resolves early when the signal aborts. */
	readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
	/** Told of each answer, with the log held so far. */
	readonly onState: (state: SyncState, log: HeldLog) => void;
	readonly signal: AbortSignal;
}

/** How following a sync ended. */
export type Followed =
	/** The sync has ended (see `state.status`). */
	| { readonly kind: 'ended'; readonly state: SyncState }
	/** The screen lost the sync: the server did not answer, or does not know it. */
	| { readonly kind: 'lost'; readonly error: unknown }
	/** The signal aborted: nobody wants the answer any more. */
	| { readonly kind: 'aborted' };

/**
 * Follows a sync by asking for its state until it has ended: the log is merged as it comes, an
 * answer that fails is asked again a few times, and an answer that says the sync is not there
 * (or too many failures in a row) ends it as lost.
 * @param deps - What asks, waits and is told
 * @returns How it ended
 * @example
 * ```ts
 * const followed = await followSync({ fetchState, isFatal, sleep, onState, signal });
 * if (followed.kind === 'ended' && followed.state.status === 'review') {
 * 	// show the differences
 * }
 * ```
 */
export async function followSync(deps: FollowDeps): Promise<Followed> {
	let held: HeldLog = NO_LOG;
	let failures = 0;
	for (;;) {
		let state: SyncState;
		try {
			state = await deps.fetchState(held.next, deps.signal);
		} catch (error) {
			if (deps.signal.aborted) {
				return { kind: 'aborted' };
			}
			failures += 1;
			if (deps.isFatal(error) || failures >= MAX_FAILURES) {
				return { kind: 'lost', error };
			}
			await deps.sleep(POLL_MS, deps.signal);
			if (deps.signal.aborted) {
				return { kind: 'aborted' };
			}
			continue;
		}
		if (deps.signal.aborted) {
			return { kind: 'aborted' };
		}
		failures = 0;
		held = mergeLog(held, state);
		deps.onState(state, held);
		if (isFinished(state.status)) {
			return { kind: 'ended', state };
		}
		await deps.sleep(POLL_MS, deps.signal);
		if (deps.signal.aborted) {
			return { kind: 'aborted' };
		}
	}
}
