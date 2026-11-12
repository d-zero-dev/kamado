import { describe, expect, test } from 'vitest';

import { english, translator } from '../i18n/translate.js';

import { columnHeading, resolveLabel } from './labels.js';

describe('resolveLabel', () => {
	test('a text is the text in every language', () => {
		expect(resolveLabel('Title', 'en')).toBe('Title');
		expect(resolveLabel('Title', 'ja')).toBe('Title');
	});

	test('a label per language is read in the language of the screen', () => {
		const label = { ja: 'タイトル', en: 'Title' };
		expect(resolveLabel(label, 'ja')).toBe('タイトル');
		expect(resolveLabel(label, 'en')).toBe('Title');
	});

	test('a language the label does not have falls back to English', () => {
		expect(resolveLabel({ en: 'Title', fr: 'Titre' }, 'ja')).toBe('Title');
	});

	test('a label with neither the language nor English is none', () => {
		expect(resolveLabel({ fr: 'Titre' }, 'ja')).toBeUndefined();
		expect(resolveLabel({}, 'en')).toBeUndefined();
		expect(resolveLabel(undefined, 'en')).toBeUndefined();
	});

	test('a name every object has is not a language of the label', () => {
		expect(resolveLabel({ en: 'Title' }, 'constructor')).toBe('Title');
		expect(resolveLabel({ fr: 'Titre' }, 'toString')).toBeUndefined();
		expect(resolveLabel({ fr: 'Titre' }, '__proto__')).toBeUndefined();
	});

	test('no label at all (undefined, or the null a config may write) is none', () => {
		expect(resolveLabel(undefined, 'en')).toBeUndefined();
		expect(resolveLabel(null, 'en')).toBeUndefined();
	});

	test('an empty text is none, so that the header is not left blank', () => {
		expect(resolveLabel('', 'en')).toBeUndefined();
		expect(resolveLabel({ ja: '', en: 'Title' }, 'ja')).toBe('Title');
		expect(resolveLabel({ ja: '', en: '' }, 'ja')).toBeUndefined();
	});
});

describe('columnHeading', () => {
	const keys = {
		title: { label: { ja: 'タイトル', en: 'Title' }, description: 'Used for <title>' },
		navHidden: { label: 'Hidden' },
		layout: { description: 'The layout file' },
		url: { label: 'URL key' },
		virtual: { description: 'A flag' },
		empty: {},
	};

	test('a key the config does not name is shown by its name, with nothing to add', () => {
		expect(columnHeading('meta:other', keys, 'en', english)).toEqual({
			name: 'other',
			detail: undefined,
		});
		expect(columnHeading('meta:other', undefined, 'en', english)).toEqual({
			name: 'other',
			detail: undefined,
		});
	});

	test('the label is the name, and the key and the description are the detail', () => {
		expect(columnHeading('meta:title', keys, 'en', english)).toEqual({
			name: 'Title',
			detail: 'title\nUsed for <title>',
		});
		expect(columnHeading('meta:title', keys, 'ja', translator('ja'))).toEqual({
			name: 'タイトル',
			detail: 'title\nUsed for <title>',
		});
	});

	test('a label alone adds the key as the detail', () => {
		expect(columnHeading('meta:navHidden', keys, 'en', english)).toEqual({
			name: 'Hidden',
			detail: 'navHidden',
		});
	});

	test('a description alone leaves the key as the name', () => {
		expect(columnHeading('meta:layout', keys, 'en', english)).toEqual({
			name: 'layout',
			detail: 'The layout file',
		});
	});

	test('a key with neither is shown as if the config did not name it', () => {
		expect(columnHeading('meta:empty', keys, 'en', english)).toEqual({
			name: 'empty',
			detail: undefined,
		});
	});

	test('the config speaks of metadata keys: a fixed column is shown as it was', () => {
		expect(columnHeading('url', keys, 'en', english)).toEqual({
			name: 'url',
			detail: undefined,
		});
	});

	test('a key called like a fixed column is told apart without a label (with a description), and has its label with one', () => {
		expect(columnHeading('meta:url', keys, 'en', english).name).toBe('URL key');
		expect(columnHeading('meta:virtual', keys, 'en', english)).toEqual({
			name: 'virtual (meta)',
			detail: 'A flag',
		});
	});

	test('a key called like a fixed column keeps its mark in the detail when a label hides it in the name', () => {
		expect(columnHeading('meta:url', keys, 'en', english)).toEqual({
			name: 'URL key',
			detail: 'url (meta)',
		});
		expect(columnHeading('meta:url', keys, 'ja', translator('ja')).detail).toBe(
			'url（メタ）',
		);
	});

	test('an empty label or description is as if it were not written', () => {
		const blank = {
			title: { label: '', description: '' },
			layout: { label: '', description: 'Layout file' },
		};
		expect(columnHeading('meta:title', blank, 'en', english)).toEqual({
			name: 'title',
			detail: undefined,
		});
		expect(columnHeading('meta:layout', blank, 'en', english)).toEqual({
			name: 'layout',
			detail: 'Layout file',
		});
	});

	test.each(['constructor', 'toString', '__proto__'])(
		'the name %s, which every object has, is not a key of the config',
		(key) => {
			expect(columnHeading(`meta:${key}`, keys, 'en', english)).toEqual({
				name: key,
				detail: undefined,
			});
		},
	);
});
