import type { SettingsPatch } from '../types.js';

import { describe, expect, test } from 'vitest';

import { createSaver, mergePatches } from './settings-save.js';

describe('mergePatches', () => {
	test('puts the fields together, the later one winning', () => {
		expect(
			mergePatches(
				{ global: { locale: 'ja' }, project: { pageSize: 100 } },
				{ project: { pageSize: 500 } },
			),
		).toEqual({ global: { locale: 'ja' }, project: { pageSize: 500 } });
	});
	test('leaves out what neither has', () => {
		expect(mergePatches({}, { global: { locale: 'en' } })).toEqual({
			global: { locale: 'en' },
		});
		expect(mergePatches({}, {})).toEqual({});
	});
});

/**
 * A saver over a fake server that answers by a script.
 * @param answers - For each call, whether it succeeds
 */
function setup(answers: boolean[]) {
	const sent: SettingsPatch[] = [];
	const reports: (string | null)[] = [];
	const save = createSaver(
		(patch) => {
			sent.push(patch);
			return answers.shift() === false
				? Promise.reject(new Error('locked'))
				: Promise.resolve();
		},
		(failure) => reports.push(failure === null ? null : (failure as Error).message),
	);
	return { save, sent, reports };
}

describe('createSaver', () => {
	test('saves one change and reports that nothing is wrong', async () => {
		const { save, sent, reports } = setup([true]);
		await save({ project: { pageSize: 100 } });
		expect(sent).toEqual([{ project: { pageSize: 100 } }]);
		expect(reports).toEqual([null]);
	});

	test('changes made together are sent together', async () => {
		const { save, sent } = setup([true]);
		const first = save({ global: { locale: 'ja' } });
		const second = save({ project: { pageSize: 1000 } });
		await Promise.all([first, second]);
		expect(sent).toEqual([{ global: { locale: 'ja' }, project: { pageSize: 1000 } }]);
	});

	test('a change made while another is on its way is sent after it, and only the last one reports success', async () => {
		const sent: SettingsPatch[] = [];
		const reports: unknown[] = [];
		let finishFirst: () => void = () => {};
		const save = createSaver(
			(patch) => {
				sent.push(patch);
				return sent.length === 1
					? new Promise<void>((resolve) => {
							finishFirst = resolve;
						})
					: Promise.resolve();
			},
			(failure) => reports.push(failure),
		);
		const first = save({ global: { locale: 'ja' } });
		await Promise.resolve();
		const second = save({ project: { pageSize: 1000 } });
		finishFirst();
		await Promise.all([first, second]);
		expect(sent).toEqual([{ global: { locale: 'ja' } }, { project: { pageSize: 1000 } }]);
		expect(reports).toEqual([null]);
	});

	test('a failure is reported, and a later success that did not carry it does not clear it', async () => {
		const { save, sent, reports } = setup([false, true]);
		await save({ global: { locale: 'ja' } });
		await save({ project: { pageSize: 1000 } });
		// The change that failed goes with the next one, so that the report is true when it clears.
		expect(sent).toEqual([
			{ global: { locale: 'ja' } },
			{ global: { locale: 'ja' }, project: { pageSize: 1000 } },
		]);
		expect(reports).toEqual(['locked', null]);
	});

	test('a failure followed by a failure is still a failure', async () => {
		const { save, reports } = setup([false, false]);
		await save({ global: { locale: 'ja' } });
		await save({ project: { pageSize: 100 } });
		expect(reports).toEqual(['locked', 'locked']);
	});

	test('a report that throws does not stop the saves after it', async () => {
		const sent: SettingsPatch[] = [];
		let calls = 0;
		const save = createSaver(
			(patch) => {
				sent.push(patch);
				return Promise.resolve();
			},
			() => {
				calls++;
				if (calls === 1) {
					throw new Error('the screen is gone');
				}
			},
		);
		await save({ global: { locale: 'ja' } });
		await save({ project: { pageSize: 100 } });
		expect(sent).toEqual([{ global: { locale: 'ja' } }, { project: { pageSize: 100 } }]);
	});

	test('a change made again after a failure replaces the one that failed', async () => {
		const { save, sent } = setup([false, true]);
		await save({ global: { locale: 'ja' } });
		await save({ global: { locale: 'en' } });
		expect(sent[1]).toEqual({ global: { locale: 'en' } });
	});
});
