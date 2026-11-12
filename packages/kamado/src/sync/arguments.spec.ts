import { describe, expect, test } from 'vitest';

import { checkCommandArguments } from '../cli-arguments.js';

describe('the arguments of sync (RFC §13)', () => {
	test('takes one name or path, --yes, --cache-dir and --config', () => {
		expect(() =>
			checkCommandArguments('sync', ['import'], {
				yes: true,
				'cache-dir': '/c',
				config: 'k.jsonc',
			}),
		).not.toThrow();
		expect(() => checkCommandArguments('sync', ['./s.mjs'], {})).not.toThrow();
	});

	test.each([
		[{ out: 'x.json' }, 'sync does not take --out (only pages writes a file)'],
		[{ port: '3000' }, 'sync does not take --port (only ui does)'],
		[{ open: true }, 'sync does not take --open (only ui does)'],
		[
			{ force: true },
			'sync does not take --force (it takes --yes, --cache-dir and --config)',
		],
		[
			{ verbose: true, incremental: true },
			'sync does not take --incremental, --verbose (it takes --yes, --cache-dir and --config)',
		],
	])('refuses a flag it does not read: %j', (flags, message) => {
		expect(() => checkCommandArguments('sync', ['import'], flags)).toThrow(message);
	});

	test('--yes is the flag of sync only', () => {
		for (const command of ['build', 'server', 'pages', 'ui']) {
			expect(() => checkCommandArguments(command, [], { yes: true }), command).toThrow(
				`${command} does not take --yes (only sync does)`,
			);
		}
	});
});
