import { describe, test, expect } from 'vitest';

import { splitPath } from './split-path.js';

describe('splitPath', () => {
	test('case 01', () => {
		const extensions = splitPath(
			'/path/to/document-root/src/file.html',
			'/path/to/document-root',
			'/path/to/',
		);
		expect(extensions).toStrictEqual({
			fromCwd: 'document-root',
			fromBase: 'src',
			name: 'file',
			ext: '.html',
		});
	});

	test('case 02', () => {
		const extensions = splitPath(
			'/path/to/document-root/file.html',
			'/path/to/document-root',
			'/path/to/',
		);
		expect(extensions).toStrictEqual({
			fromCwd: 'document-root',
			fromBase: '',
			name: 'file',
			ext: '.html',
		});
	});

	test('case 03', () => {
		const extensions = splitPath(
			//
			'/path/to/file.html',
			'/path/to/',
			'/path/to/',
		);
		expect(extensions).toStrictEqual({
			fromCwd: '',
			fromBase: '',
			name: 'file',
			ext: '.html',
		});
	});

	test('case 04', () => {
		const extensions = splitPath(
			//
			'/path/to/src/file.html',
			'/path/to/document-root',
			'/path/to/',
		);
		expect(extensions).toStrictEqual({
			fromCwd: '',
			fromBase: 'src',
			name: 'file',
			ext: '.html',
		});
	});

	test('case 05', () => {
		const extensions = splitPath(
			//
			'/path/to/src/file.html',
			'/path/to/document-root',
			'/path/',
		);
		expect(extensions).toStrictEqual({
			fromCwd: '',
			fromBase: 'to/src',
			name: 'file',
			ext: '.html',
		});
	});

	test('case 06', () => {
		const extensions = splitPath(
			//
			'/path/to/document-root/src/file.html',
			'/path/to/document-root',
			'/path/to/cwd',
		);
		expect(extensions).toStrictEqual({
			fromCwd: '../document-root',
			fromBase: 'src',
			name: 'file',
			ext: '.html',
		});
	});
});
