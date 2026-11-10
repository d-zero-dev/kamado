/**
 * What a cell shows and how what is typed in it becomes a value. The rules are those of the
 * metadata editor of BurgerEditor v4 (`front-matter-editor.tsx` in its client package), so
 * that a value is the same type here as there: the type of an input comes from the value it
 * holds, and a value written back is what the type of its input makes of the text. The rules
 * are copied, not shared (BurgerEditor is another package, and this one has no dependency on
 * it): when they change there, they are changed here by hand, with the README.
 *
 * Where this differs from BurgerEditor: a date is recognised only when the whole string is
 * a date (a string with an offset or a space is text, which an edit would otherwise cut
 * down to a day), and the day is the day as written.
 */
import type { Translate } from '../i18n/translate.js';

import { english } from '../i18n/translate.js';

/**
 * The kinds of input a value can be edited with. `list` is an array of text, numbers and
 * booleans, edited item by item; `enum` is a choice among the options that were set for the
 * column (a value that is not an option can still be shown, and is not changed unless another
 * is chosen). Both keep their draft as JSON text, as `json` does.
 */
export type FieldKind = 'text' | 'number' | 'boolean' | 'date' | 'list' | 'enum' | 'json';

/**
 * The kinds a key can be added as, in the order of the dialog. An enum is not one of them: it is
 * the kind a column is given (with its options), and a key added as one would have none.
 */
export const FIELD_KINDS: readonly FieldKind[] = [
	'text',
	'number',
	'boolean',
	'date',
	'list',
	'json',
];

/** `YYYY-MM-DD`, with a time (`T00:00:00`, and what follows it) or without. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?$/;

/**
 * Which input edits a value. A boolean is a checkbox, a number a number input, a string that
 * is a date (`2026-01-02`, `2026-01-02T03:04:05Z`) a date input, an array of text, numbers and
 * booleans (an empty one too) a list, any other array and an object a JSON text area; anything
 * else, `null` too, is text. An enum is never the kind of a value: a column is given it.
 * @param value - The value of a key
 * @example
 * ```ts
 * kindOf(true); // 'boolean'
 * kindOf('2026-01-02'); // 'date'
 * kindOf(['a', 1]); // 'list'
 * kindOf([{ a: 1 }]); // 'json'
 * kindOf(null); // 'text'
 * ```
 */
export function kindOf(value: unknown): FieldKind {
	if (typeof value === 'boolean') {
		return 'boolean';
	}
	if (typeof value === 'number') {
		return 'number';
	}
	if (
		typeof value === 'string' &&
		DATE_PATTERN.test(value) &&
		!Number.isNaN(Date.parse(value))
	) {
		return 'date';
	}
	if (
		Array.isArray(value) &&
		value.every(
			(item) =>
				typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean',
		)
	) {
		return 'list';
	}
	if (typeof value === 'object' && value !== null) {
		return 'json';
	}
	return 'text';
}

/**
 * The text a cell shows for a value: strings as they are, `null` as nothing, arrays and
 * objects as compact JSON.
 * @param value - The value of a key
 * @example
 * ```ts
 * toText(null); // ''
 * toText(['a']); // '["a"]'
 * ```
 */
export function toText(value: unknown): string {
	if (value === null || value === undefined) {
		return '';
	}
	if (typeof value === 'string') {
		return value;
	}
	if (typeof value === 'object') {
		return JSON.stringify(value);
	}
	return String(value);
}

/**
 * The text an input starts with: as {@link toText}, except that a date input takes the date
 * in UTC (what a date input shows is a day, and a time of day is dropped), a JSON text area
 * takes indented JSON, and a list and an enum take JSON in one line (an enum value as JSON
 * keeps the number 1 and the text "1" apart; a value that is not there is nothing).
 * @param value - The value of a key
 * @param kind - The kind of the input
 * @example
 * ```ts
 * draftOf('2026-01-02T23:00:00Z', 'date'); // '2026-01-02'
 * draftOf({ a: 1 }, 'json'); // '{\n  "a": 1\n}'
 * draftOf(['a', 1], 'list'); // '["a",1]'
 * ```
 */
export function draftOf(value: unknown, kind: FieldKind): string {
	if (kind === 'date' && typeof value === 'string') {
		// The day as it is written, not through `Date`: a time without `Z` is the machine's
		// local time to `Date`, and the day would move with the time zone of the browser. For
		// what `kindOf` accepts, the written day is the day in UTC.
		return value.slice(0, 10);
	}
	if (kind === 'json') {
		return JSON.stringify(value ?? [], null, 2);
	}
	if (kind === 'list') {
		return JSON.stringify(value ?? []);
	}
	if (kind === 'enum') {
		return value === null || value === undefined ? '' : JSON.stringify(value);
	}
	return toText(value);
}

/** What typing made of a draft: a value to write, or the reason there is none yet. */
export type Parsed =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly reason: string };

/**
 * The value a draft is, for the kind of its input. An empty number is `null`; JSON is
 * parsed, and a text that is not JSON is not a value (the input stays open until it is, as
 * in BurgerEditor); a JSON text that is a number or a string makes the value that type. A list
 * and an enum are JSON too, and any JSON is a value for them: the editor of a list can be
 * turned into the JSON of the value, which may be an array of objects.
 * @param kind - The kind of the input
 * @param draft - The text of the input
 * @param t - Says why a text is not a value, in the language of the screen (English by default)
 * @example
 * ```ts
 * parseDraft('number', ''); // { ok: true, value: null }
 * parseDraft('json', '{'); // { ok: false, reason: ... }
 * ```
 */
export function parseDraft(
	kind: FieldKind,
	draft: string,
	t: Translate = english,
): Parsed {
	switch (kind) {
		case 'number': {
			if (draft.trim() === '') {
				return { ok: true, value: null };
			}
			const value = Number(draft);
			return Number.isFinite(value)
				? { ok: true, value }
				: { ok: false, reason: t('value.notNumber', { draft }) };
		}
		case 'json':
		case 'list':
		case 'enum': {
			try {
				return { ok: true, value: JSON.parse(draft) as unknown };
			} catch (error) {
				return {
					ok: false,
					reason: t('value.notJson', {
						message: error instanceof Error ? error.message : String(error),
					}),
				};
			}
		}
		case 'boolean': {
			return { ok: true, value: draft === 'true' };
		}
		default: {
			return { ok: true, value: draft };
		}
	}
}

/**
 * Whether two values are the same for the purpose of not writing the file again.
 * @param a - A value
 * @param b - Another
 * @example
 * ```ts
 * sameValue({ a: [1] }, { a: [1] }); // true
 * sameValue(null, ''); // false
 * ```
 */
export function sameValue(a: unknown, b: unknown): boolean {
	return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The value a key added as `kind` starts with.
 * @param kind - The kind of the key
 * @param now - The time, for a date (the day in UTC)
 * @example
 * ```ts
 * defaultOf('number'); // 0
 * defaultOf('date', new Date('2026-01-02T23:00:00Z')); // '2026-01-02'
 * ```
 */
export function defaultOf(kind: FieldKind, now: Date = new Date()): unknown {
	switch (kind) {
		case 'number': {
			return 0;
		}
		case 'boolean': {
			return false;
		}
		case 'date': {
			return now.toISOString().slice(0, 10);
		}
		case 'json':
		case 'list': {
			return [];
		}
		default: {
			return '';
		}
	}
}
