import { describe, expect, test } from 'vitest';

import { checkCommandArguments } from './cli-arguments.js';
import { checkUiArguments } from './ui/arguments.js';

describe('--verify-deps', () => {
	test('build takes it', () => {
		expect(() =>
			checkCommandArguments('build', [], { 'verify-deps': true }),
		).not.toThrow();
	});

	test.each(['server', 'pages'])('%s refuses it and says what it takes', (command) => {
		expect(() => checkCommandArguments(command, [], { 'verify-deps': true })).toThrow(
			`${command} does not take --verify-deps`,
		);
	});

	test('ui refuses it', () => {
		expect(() => checkUiArguments([], { 'verify-deps': true })).toThrow(
			'ui does not take --verify-deps',
		);
	});

	test('a default of false is not given', () => {
		expect(() =>
			checkCommandArguments('server', [], { 'verify-deps': false }),
		).not.toThrow();
	});
});
