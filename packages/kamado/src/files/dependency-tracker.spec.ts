import { setTimeout as sleep } from 'node:timers/promises';

import { describe, test, expect } from 'vitest';

import { collectDependencies, trackDependency } from './dependency-tracker.js';

describe('dependency tracker', () => {
	test('collectDependencies captures tracked paths and the run result', async () => {
		const { result, dependencies } = await collectDependencies(() => {
			trackDependency('/site/page.pug');
			trackDependency('/site/layout.pug');
			trackDependency('/site/page.pug');
			return Promise.resolve('compiled');
		});

		expect(result).toBe('compiled');
		expect([...dependencies].toSorted()).toStrictEqual([
			'/site/layout.pug',
			'/site/page.pug',
		]);
	});

	test('trackDependency outside a collection scope is a no-op', () => {
		expect(() => trackDependency('/outside.txt')).not.toThrow();
	});

	test('tracking survives await boundaries inside the collected run', async () => {
		const { dependencies } = await collectDependencies(async () => {
			trackDependency('/before-await.txt');
			await sleep(1);
			trackDependency('/after-await.txt');
		});

		expect([...dependencies].toSorted()).toStrictEqual([
			'/after-await.txt',
			'/before-await.txt',
		]);
	});

	test('concurrent collections are isolated from each other', async () => {
		const [first, second] = await Promise.all([
			collectDependencies(async () => {
				trackDependency('/first-1.txt');
				await sleep(2);
				trackDependency('/first-2.txt');
			}),
			collectDependencies(async () => {
				trackDependency('/second-1.txt');
				await sleep(1);
				trackDependency('/second-2.txt');
			}),
		]);

		expect([...first.dependencies].toSorted()).toStrictEqual([
			'/first-1.txt',
			'/first-2.txt',
		]);
		expect([...second.dependencies].toSorted()).toStrictEqual([
			'/second-1.txt',
			'/second-2.txt',
		]);
	});
});
