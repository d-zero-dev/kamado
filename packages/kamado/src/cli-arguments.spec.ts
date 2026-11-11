import { describe, expect, test } from 'vitest';

import { checkCommandArguments, checkSettingsOnlyFlag } from './cli-arguments.js';

describe('checkCommandArguments', () => {
	test('build takes globs and its flags', () => {
		expect(() =>
			checkCommandArguments('build', ['src/**'], {
				incremental: true,
				force: true,
				'skip-unchanged': true,
				jobs: 'auto',
				verbose: true,
			}),
		).not.toThrow();
	});

	test('server refuses a positional and the flags of build', () => {
		expect(() => checkCommandArguments('server', ['foo'], {})).toThrow(
			'server takes no arguments',
		);
		expect(() => checkCommandArguments('server', [], { force: true })).toThrow(
			'server does not take --force (it takes --verbose, --cache-dir and --config)',
		);
		expect(() => checkCommandArguments('server', [], { incremental: true })).toThrow(
			'--incremental',
		);
	});

	test('pages refuses a glob and the flags of build', () => {
		expect(() => checkCommandArguments('pages', ['src/news/**'], {})).toThrow(
			'pages takes no arguments (it lists every page of the plan)',
		);
		expect(() => checkCommandArguments('pages', [], { force: true })).toThrow(
			'pages does not take --force',
		);
		expect(() => checkCommandArguments('pages', [], { jobs: 'auto' })).toThrow(
			'pages does not take --jobs',
		);
		expect(() => checkCommandArguments('pages', [], { 'skip-unchanged': true })).toThrow(
			'pages does not take --skip-unchanged',
		);
		expect(() => checkCommandArguments('pages', [], { verbose: true })).toThrow(
			'pages does not take --verbose',
		);
		expect(() =>
			checkCommandArguments('pages', [], { force: true, jobs: '2', verbose: true }),
		).toThrow(
			'pages does not take --force, --jobs, --verbose (it takes --out, --incremental, --cache-dir and --config)',
		);
	});

	test('ui refuses a positional and the flags of the other commands', () => {
		expect(() => checkCommandArguments('ui', ['src/**'], {})).toThrow(
			/takes no arguments/,
		);
		expect(() => checkCommandArguments('ui', [], { out: 'a.json' })).toThrow(
			'ui does not take --out (only pages writes a file)',
		);
		expect(() => checkCommandArguments('ui', [], { force: true })).toThrow('--force');
		expect(() => checkCommandArguments('ui', [], { incremental: true })).toThrow(
			'--incremental',
		);
	});

	test('build and server refuse --out with the ownership clause', () => {
		expect(() => checkCommandArguments('build', [], { out: 'x.json' })).toThrow(
			'build does not take --out (only pages writes a file)',
		);
		expect(() => checkCommandArguments('server', [], { out: 'x.json' })).toThrow(
			'server does not take --out (only pages writes a file)',
		);
	});

	test('build, server and pages refuse the flags of ui', () => {
		for (const command of ['build', 'server', 'pages'] as const) {
			expect(() => checkCommandArguments(command, [], { port: '1' })).toThrow(
				`${command} does not take --port (only ui does)`,
			);
			expect(() => checkCommandArguments(command, [], { open: true })).toThrow('--open');
			expect(() => checkCommandArguments(command, [], { 'no-open': true })).toThrow(
				'--no-open',
			);
		}
	});

	test('build, server, pages and ui refuse --all', () => {
		for (const command of ['build', 'server', 'pages', 'ui'] as const) {
			expect(() => checkCommandArguments(command, [], { all: true })).toThrow(
				`${command} does not take --all (only ui-settings delete does)`,
			);
		}
	});

	test('boolean defaults of false are not treated as given', () => {
		expect(() =>
			checkCommandArguments('pages', [], {
				force: false,
				'skip-unchanged': false,
				verbose: false,
				jobs: undefined,
			}),
		).not.toThrow();
	});
});

describe('checkSettingsOnlyFlag', () => {
	test('refuses --all and allows its absence', () => {
		expect(() => checkSettingsOnlyFlag('build', { all: true })).toThrow(
			'build does not take --all (only ui-settings delete does)',
		);
		expect(() => checkSettingsOnlyFlag('build', {})).not.toThrow();
	});
});
