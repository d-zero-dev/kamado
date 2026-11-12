import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import plugin from './index.js';

const { version } = JSON.parse(
	readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

describe('the plugin', () => {
	test('is named for the prefix of its rules and carries the version of the package', () => {
		expect(plugin.meta).toStrictEqual({ name: '@kamado-io', version });
	});

	test('has the seven rules, each with the messages it reports', () => {
		expect(Object.keys(plugin.rules).toSorted()).toStrictEqual([
			'no-async-component',
			'no-client-directive',
			'no-function-event-handler',
			'no-ignored-props',
			'no-module-state',
			'no-react-runtime',
			'no-untracked-input',
		]);
		for (const rule of Object.values(plugin.rules)) {
			expect(rule.meta?.type).toBe('problem');
			expect(rule.meta?.docs?.description).toMatch(/\S/);
			expect(Object.keys(rule.meta?.messages ?? {}).length).toBeGreaterThan(0);
		}
	});
});
