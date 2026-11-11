import { describe, expect, test } from 'vitest';

import { pathChangeOf } from './move-path.js';

describe('pathChangeOf', () => {
	test('is a move to the path that was typed', () => {
		expect(
			pathChangeOf({ inputPath: 'customer/send/index.html' }, 'customer/sending/'),
		).toEqual({
			op: 'movePath',
			path: 'customer/sending/',
		});
	});

	test('is sent as typed: the core reads it from the input directory and folds it', () => {
		expect(pathChangeOf({ inputPath: 'a.html' }, '/b\\c/../d.html')).toEqual({
			op: 'movePath',
			path: '/b\\c/../d.html',
		});
	});

	test('is nothing when the path is the one the page has', () => {
		expect(pathChangeOf({ inputPath: 'a/index.html' }, 'a/index.html')).toBeNull();
	});

	test('is nothing for a page without a file', () => {
		expect(pathChangeOf({ inputPath: null }, 'a/')).toBeNull();
	});
});
