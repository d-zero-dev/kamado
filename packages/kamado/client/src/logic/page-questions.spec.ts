import type { PageQuestion } from './page-questions.js';

import { describe, expect, test } from 'vitest';

import { translator } from '../i18n/translate.js';

import { answerOf, holdsVirtualPages, saidAfterLoad } from './page-questions.js';

const EXPECT = { input: 'h', sidecar: null, overrides: 'o' };

/**
 * A question about a page that is there.
 * @param kind - What is asked
 */
function about(kind: 'delete' | 'emptyPath' | 'virtualize'): PageQuestion {
	return { kind, url: '/a/', files: ['a/index.html'], virtual: false, expect: EXPECT };
}

describe('what an answer to a question comes to', () => {
	test('a virtual page is added when adding is chosen', () => {
		expect(answerOf({ kind: 'addVirtual', url: '/v/' }, 'add')).toEqual({
			kind: 'create',
			url: '/v/',
		});
	});

	test('an emptied inputPath makes the page virtual or deletes it, on the hashes the dialog had', () => {
		expect(answerOf(about('emptyPath'), 'virtualize')).toEqual({
			kind: 'virtualize',
			url: '/a/',
			expect: EXPECT,
		});
		expect(answerOf(about('emptyPath'), 'delete')).toEqual({
			kind: 'delete',
			url: '/a/',
			expect: EXPECT,
		});
	});

	test('the box of virtual only makes the page virtual, and an emptied url only deletes it', () => {
		expect(answerOf(about('virtualize'), 'virtualize')).toMatchObject({
			kind: 'virtualize',
		});
		expect(answerOf(about('delete'), 'delete')).toMatchObject({ kind: 'delete' });
	});

	test('a choice the question does not offer does nothing', () => {
		expect(answerOf(about('virtualize'), 'delete')).toBeNull();
		expect(answerOf(about('delete'), 'virtualize')).toBeNull();
		expect(answerOf(about('emptyPath'), 'add')).toBeNull();
		expect(answerOf({ kind: 'addVirtual', url: '/v/' }, 'delete')).toBeNull();
		expect(answerOf({ kind: 'addVirtual', url: '/v/' }, 'virtualize')).toBeNull();
	});
});

describe('whether the site can hold a virtual page', () => {
	test('it can when it has a pages.overrides file', () => {
		expect(holdsVirtualPages('pages.overrides.json')).toBe(true);
	});

	test('it cannot when it has none, or when the list does not say', () => {
		expect(holdsVirtualPages(null)).toBe(false);
		// eslint-disable-next-line unicorn/no-useless-undefined -- the list of a server that does not say it
		expect(holdsVirtualPages(undefined)).toBe(false);
	});
});

describe('what is said once the list was read again', () => {
	test('what was done to the page, when that was said', () => {
		expect(saidAfterLoad(['/a/'], '/a/', 'Page /a/ added')).toBe('Page /a/ added');
		expect(saidAfterLoad(['/a/'], '/z/', 'Page /z/ added')).toBe(
			'Page /z/ added (not on this page)',
		);
	});

	test('that the page was moved, when nothing else was said of it', () => {
		expect(saidAfterLoad(['/a/', '/b/'], '/b/', null)).toBe('Moved to /b/');
		expect(saidAfterLoad(['/a/'], '/z/', null)).toBe('Moved to /z/ (not on this page)');
	});

	test('nothing, when the focus was to go nowhere: what was said of another page is not said', () => {
		expect(saidAfterLoad(['/a/'], null, 'Page /a/ added')).toBeNull();
		expect(saidAfterLoad(['/a/'], null, null)).toBeNull();
	});

	test('in the language of the screen', () => {
		expect(saidAfterLoad([], '/z/', '/z/ を追加しました', translator('ja'))).toBe(
			'/z/ を追加しました（このページには表示されていません）',
		);
	});
});
