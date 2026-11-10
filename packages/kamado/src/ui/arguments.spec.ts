import { describe, expect, test } from 'vitest';

import { checkUiArguments, checkUiOnlyFlags, parseOpen, parsePort } from './arguments.js';

describe('checkUiArguments', () => {
	test('flags of ui are fine, and nothing at all is', () => {
		expect(() => checkUiArguments([], {})).not.toThrow();
	});
	test('a position argument is refused', () => {
		expect(() => checkUiArguments(['src/**'], {})).toThrow(/takes no arguments/);
	});
	test.each([
		[{ out: 'a.json' }, '--out'],
		[{ force: true }, '--force'],
		[{ jobs: '2' }, '--jobs'],
		[{ 'skip-unchanged': true }, '--skip-unchanged'],
		[{ incremental: true }, '--incremental'],
		[{ verbose: true }, '--verbose'],
	])('%j is refused', (flags, name) => {
		expect(() => checkUiArguments([], flags)).toThrow(name);
	});
});

describe('checkUiOnlyFlags', () => {
	test.each(['build', 'server', 'pages'])('%s refuses the flags of ui', (command) => {
		expect(() => checkUiOnlyFlags(command, { port: '1' })).toThrow(
			`${command} does not take --port`,
		);
		expect(() => checkUiOnlyFlags(command, { open: true })).toThrow('--open');
		expect(() => checkUiOnlyFlags(command, { 'no-open': true })).toThrow('--no-open');
	});
	test('without them it is fine', () => {
		expect(() => checkUiOnlyFlags('build', {})).not.toThrow();
	});
});

describe('parsePort', () => {
	test('a port, or the default', () => {
		expect(parsePort('3001')).toBe(3001);
		expect(parsePort('1')).toBe(1);
		expect(parsePort('65535')).toBe(65_535);
		expect(parsePort()).toBeUndefined();
	});
	test.each(['', '0', 'abc', '-1', '65536', '1.5', '1e3'])('"%s" is refused', (value) => {
		expect(() => parsePort(value)).toThrow(/--port/);
	});
});

describe('parseOpen', () => {
	test('is the flag that was given, or the default of the config', () => {
		expect(parseOpen({ open: true })).toBe(true);
		expect(parseOpen({ 'no-open': true })).toBe(false);
		expect(parseOpen({})).toBeUndefined();
	});
	test('both are refused', () => {
		expect(() => parseOpen({ open: true, 'no-open': true })).toThrow(/together/);
	});
});
