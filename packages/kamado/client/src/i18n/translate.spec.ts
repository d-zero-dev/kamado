import { describe, expect, test } from 'vitest';

import { editBlockedReason, focusAfterLoad } from '../logic/session.js';
import { parseDraft } from '../logic/value.js';

import { en, ja } from './messages.js';
import { english, resolveLanguage, translator } from './translate.js';

/**
 * The names between braces in a message.
 * @param text - A message
 */
function placeholders(text: string): string[] {
	return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').toSorted();
}

describe('the messages', () => {
	test('Japanese has every message English has, and no other', () => {
		expect(Object.keys(ja).toSorted()).toEqual(Object.keys(en).toSorted());
	});
	test.each(Object.keys(en) as (keyof typeof en)[])(
		'%s is not empty and names the same values in both languages',
		(key) => {
			expect(en[key]).not.toBe('');
			expect(ja[key]).not.toBe('');
			expect(placeholders(ja[key])).toEqual(placeholders(en[key]));
		},
	);
});

describe('translator', () => {
	test('fills the values in', () => {
		expect(translator('en')('app.saved', { key: 'title' })).toBe('title saved');
		expect(translator('ja')('app.saved', { key: 'title' })).toBe('title を保存しました');
	});
	test('a value that looks like a placeholder is put in as it is', () => {
		expect(translator('en')('app.saved', { key: '{key}' })).toBe('{key} saved');
		expect(translator('en')('app.moved', { url: '$&{url}' })).toBe('Moved to $&{url}');
	});
	test('a name that is not a message is shown as it is, and does not stop the screen', () => {
		const t = translator('ja') as (key: string) => string;
		expect(t('origin.somethingNew')).toBe('origin.somethingNew');
	});
	test('every place a value is written has a name for it in both languages', () => {
		for (const origin of ['inFile', 'sidecar', 'overrides']) {
			expect(`origin.${origin}` in en).toBe(true);
		}
		for (const kind of ['text', 'number', 'boolean', 'date', 'json']) {
			expect(`kind.${kind}` in en).toBe(true);
		}
	});
	test('english is the translator of English', () => {
		expect(english('app.readAgain')).toBe('Read again');
	});
});

describe('resolveLanguage', () => {
	test('a language that is set is the language', () => {
		expect(resolveLanguage('ja', ['en-US'])).toBe('ja');
		expect(resolveLanguage('en', ['ja-JP'])).toBe('en');
	});
	test('auto follows the first language of the browser', () => {
		expect(resolveLanguage('auto', ['ja-JP', 'en-US'])).toBe('ja');
		expect(resolveLanguage('auto', ['ja'])).toBe('ja');
		expect(resolveLanguage('auto', ['en-US', 'ja'])).toBe('en');
		expect(resolveLanguage('auto', ['fr-FR'])).toBe('en');
		expect(resolveLanguage('auto', [])).toBe('en');
	});
});

describe('the logic of the screen in Japanese', () => {
	const t = translator('ja');
	test('says why an edit is not sent', () => {
		expect(editBlockedReason('busy', t)).toBe(ja['session.busy']);
		expect(editBlockedReason('ok', t)).toBeNull();
	});
	test('says where a moved page went', () => {
		expect(focusAfterLoad(['/a/'], 0, '/z/', t).said).toBe(
			t('app.movedElsewhere', { url: '/z/' }),
		);
	});
	test('says why a draft is not a value', () => {
		const parsed = parseDraft('number', 'abc', t);
		expect(parsed.ok).toBe(false);
		expect(!parsed.ok && parsed.reason).toBe(t('value.notNumber', { draft: 'abc' }));
	});
});
