import { describe, test, expect } from 'vitest';

import { createCustomCompiler } from './create-custom-compiler.js';

const factoryWithoutDefaults = () => ({
	defaultFiles: '**/*.x',
	defaultOutputExtension: '.x',
	compile: () => () => '',
});

const factoryWithDefaults = () => ({
	defaultFiles: '**/*.x',
	defaultOutputExtension: '.x',
	defaultOutputPathField: 'path',
	compile: () => () => '',
});

describe('createCustomCompiler', () => {
	test('outputPathField is undefined when neither user nor factory sets it', () => {
		const entry = createCustomCompiler(factoryWithoutDefaults)();
		expect(entry.outputPathField).toBeUndefined();
	});

	test('user-provided outputPathField is propagated to the entry', () => {
		const entry = createCustomCompiler(factoryWithoutDefaults)({
			outputPathField: 'permalink',
		});
		expect(entry.outputPathField).toBe('permalink');
	});

	test('falls back to factory defaultOutputPathField when user omits it', () => {
		const entry = createCustomCompiler(factoryWithDefaults)();
		expect(entry.outputPathField).toBe('path');
	});

	test('user-provided outputPathField overrides factory default', () => {
		const entry = createCustomCompiler(factoryWithDefaults)({
			outputPathField: 'permalink',
		});
		expect(entry.outputPathField).toBe('permalink');
	});

	test('empty user options object preserves factory default', () => {
		const entry = createCustomCompiler(factoryWithDefaults)({});
		expect(entry.outputPathField).toBe('path');
	});

	test('files and outputExtension fall back to factory defaults', () => {
		const entry = createCustomCompiler(factoryWithoutDefaults)();
		expect(entry.files).toBe('**/*.x');
		expect(entry.outputExtension).toBe('.x');
	});

	test('user-provided files and outputExtension override factory defaults', () => {
		const entry = createCustomCompiler(factoryWithoutDefaults)({
			files: '**/*.y',
			outputExtension: '.y',
		});
		expect(entry.files).toBe('**/*.y');
		expect(entry.outputExtension).toBe('.y');
	});

	test('ignore is forwarded to the entry', () => {
		const entry = createCustomCompiler(factoryWithoutDefaults)({
			ignore: '**/_*',
		});
		expect(entry.ignore).toBe('**/_*');
	});

	test('outputPathConflict is undefined when user omits it', () => {
		const entry = createCustomCompiler(factoryWithoutDefaults)();
		expect(entry.outputPathConflict).toBeUndefined();
	});

	test('user-provided outputPathConflict "silent" is propagated', () => {
		const entry = createCustomCompiler(factoryWithoutDefaults)({
			outputPathConflict: 'silent',
		});
		expect(entry.outputPathConflict).toBe('silent');
	});

	test('user-provided outputPathConflict "error" is propagated', () => {
		const entry = createCustomCompiler(factoryWithoutDefaults)({
			outputPathConflict: 'error',
		});
		expect(entry.outputPathConflict).toBe('error');
	});

	test('user-provided outputPathConflict "warning" is propagated', () => {
		const entry = createCustomCompiler(factoryWithoutDefaults)({
			outputPathConflict: 'warning',
		});
		expect(entry.outputPathConflict).toBe('warning');
	});
});
