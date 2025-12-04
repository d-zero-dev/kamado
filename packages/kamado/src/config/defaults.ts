import type { ExtensionOutputTypeMap } from '../files/types.js';

/**
 * Default extension to output file type mapping
 */
export const DEFAULT_EXTENSIONS: ExtensionOutputTypeMap = {
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
