/**
 * Keeping the settings of the screen, apart from drawing it: the changes are sent one at a
 * time in the order they were made, and a change that could not be saved is sent again with
 * the next one. So a later save that succeeds clears the report of a failure only when it
 * carried what failed: the language that did not reach the file is not reported as kept
 * because the page size after it did.
 */
import type { SettingsPatch } from '../types.js';

/**
 * Puts two changes together; the fields of the later one win.
 * @param earlier - The change made first
 * @param later - The change made after it
 * @example
 * ```ts
 * mergePatches({ global: { locale: 'ja' } }, { project: { pageSize: 100 } });
 * // { global: { locale: 'ja' }, project: { pageSize: 100 } }
 * ```
 */
export function mergePatches(
	earlier: SettingsPatch,
	later: SettingsPatch,
): SettingsPatch {
	const global = { ...earlier.global, ...later.global };
	const project = { ...earlier.project, ...later.project };
	return {
		...(Object.keys(global).length === 0 ? {} : { global }),
		...(Object.keys(project).length === 0 ? {} : { project }),
	};
}

/**
 * Makes the function that keeps changes.
 * @param send - Sends a change to the server (rejects when it was not saved)
 * @param report - Called after each attempt: the failure, or `null` when what was asked for is
 * all saved
 * @returns Keeps a change; resolves when the attempt it made has ended
 * @example
 * ```ts
 * const save = createSaver((patch) => saveSettings(patch), (failure) => show(failure));
 * await save({ project: { pageSize: 100 } });
 * ```
 */
export function createSaver(
	send: (patch: SettingsPatch) => Promise<unknown>,
	report: (failure: unknown) => void,
): (patch: SettingsPatch) => Promise<void> {
	let pending: SettingsPatch = {};
	let tail: Promise<void> = Promise.resolve();
	return (patch) => {
		pending = mergePatches(pending, patch);
		tail = tail
			.then(async () => {
				const batch = pending;
				if (Object.keys(batch).length === 0) {
					return;
				}
				pending = {};
				let failure: { readonly error: unknown } | null = null;
				try {
					await send(batch);
				} catch (error) {
					// What was not saved goes again with the next change, and the newer fields win.
					pending = mergePatches(batch, pending);
					failure = { error };
				}
				// Outside the `try`: a report that throws is not a save that failed.
				if (failure !== null) {
					report(failure.error);
				} else if (Object.keys(pending).length === 0) {
					// A change made while this one was on its way is sent next, and reports for itself.
					report(null);
				}
			})
			// A report that throws must not leave the chain rejected: no save after it would run.
			.catch(() => {});
		return tail;
	};
}
