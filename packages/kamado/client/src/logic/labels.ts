import type { Translate } from '../i18n/translate.js';

import { columnLabel, columnName } from './layout.js';

/**
 * A text of `ui.keys` (RFC section 14.2): one text for every language, or a text per language of the
 * screen (`en`, `ja`). `null` is no text: the schema lets a config write it, and a screen that
 * is handed one must not fail on it.
 */
export type Label = string | Readonly<Record<string, string>> | null;

/** How the config presents one metadata key. */
export interface KeyPresentation {
	readonly label?: Label;
	readonly description?: Label;
}

/** What `ui.keys` of the config holds: the key, and how it is presented. */
export type KeyPresentations = Readonly<Record<string, KeyPresentation>>;

/** What the screen shows of a column: its name, and what goes with it on hover and in the menu. */
export interface ColumnHeading {
	/** The name shown in the header, the menu and what is said of the column. */
	readonly name: string;
	/**
	 * The lines that tell more: the key (when the name is a label and not the key) and the
	 * description, each on a line of its own. `undefined` when there is nothing to add.
	 */
	readonly detail: string | undefined;
}

/**
 * The text of a label in a language: the text itself, or the one written for the language, or
 * the English one when the language has none. `undefined` when there is none of them (the key
 * is then shown instead). An empty text is none: it would leave the header blank. Only what the
 * label itself holds counts, so a language called `constructor` is not read from the prototype
 * of the object.
 * @param label - The label of `ui.keys`
 * @param language - The language of the screen
 * @example
 * ```ts
 * resolveLabel({ ja: 'タイトル', en: 'Title' }, 'ja'); // 'タイトル'
 * resolveLabel({ en: 'Title' }, 'ja'); // 'Title'
 * resolveLabel({ fr: 'Titre' }, 'ja'); // undefined
 * ```
 */
export function resolveLabel(
	label: Label | undefined,
	language: string,
): string | undefined {
	if (label === undefined || label === null) {
		return undefined;
	}
	if (typeof label === 'string') {
		return label === '' ? undefined : label;
	}
	for (const name of [language, 'en']) {
		if (Object.hasOwn(label, name)) {
			const text = label[name];
			if (typeof text === 'string' && text !== '') {
				return text;
			}
		}
	}
	return undefined;
}

/**
 * What the screen shows of a column. The config speaks of metadata keys only: the fixed columns
 * (`url`, `inputPath`, ...) are shown as `columnLabel` shows them.
 * @param id - The identifier of the column
 * @param keys - `ui.keys` of the config (`undefined` for a list made by hand without it)
 * @param language - The language of the screen
 * @param t - Says the mark of a key that is called like a fixed column
 * @example
 * ```ts
 * const keys = { title: { label: { ja: 'タイトル' }, description: 'Used for <title>' } };
 * columnHeading('meta:title', keys, 'ja', translator('ja'));
 * // { name: 'タイトル', detail: 'title\nUsed for <title>' }
 * ```
 */
export function columnHeading(
	id: string,
	keys: KeyPresentations | undefined,
	language: string,
	t: Translate,
): ColumnHeading {
	const plain = columnLabel(id, t);
	if (!id.startsWith('meta:') || keys === undefined) {
		return { name: plain, detail: undefined };
	}
	const key = columnName(id);
	const presentation = Object.hasOwn(keys, key) ? keys[key] : undefined;
	const label = resolveLabel(presentation?.label, language);
	const description = resolveLabel(presentation?.description, language);
	// The key is told as `plain` tells it, so that a key called like a fixed column keeps its
	// mark in the detail even when its label hides the mark in the name.
	const lines = [
		...(label === undefined ? [] : [plain]),
		...(description === undefined ? [] : [description]),
	];
	return {
		name: label ?? plain,
		detail: lines.length === 0 ? undefined : lines.join('\n'),
	};
}
