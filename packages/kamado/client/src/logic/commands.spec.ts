import { describe, expect, test, vi } from 'vitest';

import { builtinCommand, customCommand, customNameOf, runCommand } from './commands.js';

describe('builtinCommand', () => {
	test('names the dialog and the command the browser carries out', () => {
		expect(builtinCommand('add-page-dialog', 'show-modal')).toEqual({
			commandfor: 'add-page-dialog',
			command: 'show-modal',
		});
	});
});

describe('customCommand', () => {
	test('prefixes the name, as the API requires of a command that is not its own', () => {
		expect(customCommand('app', 'next')).toEqual({
			commandfor: 'app',
			command: '--next',
		});
	});
});

describe('customNameOf', () => {
	test('gives the name of a command of the screen', () => {
		expect(customNameOf('--next')).toBe('next');
		expect(customNameOf('--read-again')).toBe('read-again');
	});

	test('is null for a command the browser carries out', () => {
		expect(customNameOf('close')).toBeNull();
		expect(customNameOf('show-modal')).toBeNull();
	});

	test('is null for a prefix with no name', () => {
		expect(customNameOf('--')).toBeNull();
		expect(customNameOf('')).toBeNull();
	});
});

describe('runCommand', () => {
	test('runs the handler of the name with the button', () => {
		const next = vi.fn();
		const previous = vi.fn();
		expect(runCommand({ next, previous }, '--next', 'button')).toBe(true);
		expect(next).toHaveBeenCalledExactlyOnceWith('button');
		expect(previous).not.toHaveBeenCalled();
	});

	test('runs nothing for a name that has no handler', () => {
		const next = vi.fn();
		expect(runCommand({ next }, '--other', 'button')).toBe(false);
		expect(next).not.toHaveBeenCalled();
	});

	test('runs nothing for a command the browser carries out', () => {
		const close = vi.fn();
		expect(runCommand({ close }, 'close', 'button')).toBe(false);
		expect(close).not.toHaveBeenCalled();
	});

	test('does not take a name of Object.prototype for a handler', () => {
		expect(runCommand({}, '--toString', 'button')).toBe(false);
		expect(runCommand({}, '--constructor', 'button')).toBe(false);
	});
});
