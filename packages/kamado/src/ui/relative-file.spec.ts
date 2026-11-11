import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { relativeFile } from './start.js';

describe('relativeFile', () => {
	const root = path.join(path.sep, 'site');

	test('is the path from the directory, with a slash', () => {
		expect(relativeFile(root, path.join(root, 'data', 'pages.overrides.json'))).toBe(
			'data/pages.overrides.json',
		);
		expect(relativeFile(root, path.join(root, 'pages.overrides.json'))).toBe(
			'pages.overrides.json',
		);
	});

	test('is the name of a file that is outside the directory, so that no path of the machine goes out', () => {
		expect(relativeFile(root, path.join(path.sep, 'elsewhere', 'p.json'))).toBe('p.json');
		expect(relativeFile(root, path.join(path.dirname(root), 'p.json'))).toBe('p.json');
		expect(relativeFile(root, path.join(root, '..', 'sibling', 'p.json'))).toBe('p.json');
	});

	test('keeps a name that starts with two dots inside the directory', () => {
		expect(relativeFile(root, path.join(root, '..data', 'o.json'))).toBe('..data/o.json');
		expect(relativeFile(root, path.join(root, '..o.json'))).toBe('..o.json');
	});

	test('is the name of the file for the directory itself', () => {
		expect(relativeFile(root, root)).toBe('site');
	});
});
