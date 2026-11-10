import type { MessageKey } from './messages.js';

import { en, ja } from './messages.js';

/** A language the screen speaks. */
export type Language = 'en' | 'ja';

/** The language setting: a language, or `auto` for the browser's. */
export type LocaleSetting = 'auto' | Language;

/** Values put into the `{name}`s of a message. */
export type Params = Readonly<Record<string, string | number>>;

/** Says a message in the language it was made for. */
export type Translate = (key: MessageKey, params?: Params) => string;

const DICTIONARIES: Record<Language, Record<MessageKey, string>> = { en, ja };

/**
 * The translator of a language. A value is put in as it is: one that looks like a `{name}` (a
 * URL or a key can hold braces) is not filled in again, and `$` in it means nothing special.
 * @param language - The language
 * @example
 * ```ts
 * translator('ja')('app.saved', { key: 'title' }); // 'title を保存しました'
 * ```
 */
export function translator(language: Language): Translate {
	const words = DICTIONARIES[language];
	// A name that is not in the dictionary (the core returned a place a value is written that
	// this screen has no word for) is shown as it is: a missing word must not stop the screen.
	return (key, params = {}) =>
		(words[key] ?? key).replaceAll(/\{(\w+)\}/g, (whole, name: string) =>
			Object.hasOwn(params, name) ? String(params[name]) : whole,
		);
}

/** The translator of English: what the logic of the screen says unless it is given another. */
export const english: Translate = translator('en');

/**
 * The language to speak: the one that is set, or, for `auto`, that of the first language the
 * browser lists (Japanese if it is one, otherwise English).
 * @param setting - The language setting
 * @param preferred - The languages of the browser, most wanted first (`navigator.languages`)
 * @example
 * ```ts
 * resolveLanguage('auto', ['ja-JP', 'en-US']); // 'ja'
 * resolveLanguage('en', ['ja-JP']); // 'en'
 * ```
 */
export function resolveLanguage(
	setting: LocaleSetting,
	preferred: readonly string[],
): Language {
	if (setting !== 'auto') {
		return setting;
	}
	return preferred[0]?.toLowerCase().split('-')[0] === 'ja' ? 'ja' : 'en';
}
