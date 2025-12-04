import type { ExtensionOutputTypeMap } from '../files/types.js';

import { describe, test, expect } from 'vitest';

import { extractExtensions } from './extension.js';

const outputFileTypeMap: ExtensionOutputTypeMap = {
	html: 'page',
	pug: 'page',
	css: 'style',
	scss: 'style',
	sass: 'style',
	js: 'script',
	mjs: 'script',
	cjs: 'script',
	jsx: 'script',
	ts: 'script',
	tsx: 'script',
};

describe('extractExtensions', () => {
	test('should extract page extensions', () => {
		const extensions = extractExtensions('page', outputFileTypeMap);
		expect(extensions).toEqual(['html', 'pug']);
	});

	test('should extract style extensions', () => {
		const extensions = extractExtensions('style', outputFileTypeMap);
		expect(extensions).toEqual(['css', 'scss', 'sass']);
	});

	test('should extract script extensions', () => {
		const extensions = extractExtensions('script', outputFileTypeMap);
		expect(extensions).toEqual(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx']);
	});

	test('use #ignore', () => {
		const extensions = extractExtensions('page', {
			...outputFileTypeMap,
			html: '#ignore',
		});
		expect(extensions).toEqual(['pug']);
	});
});
