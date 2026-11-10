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

/** The kinds of input a value can be edited with. */
export type FieldKind = 'text' | 'number' | 'boolean' | 'date' | 'json';

/** The kinds a key can be added as (the same list, in the order of the dialog). */
export const FIELD_KINDS: readonly FieldKind[] = [
	'text',
	'number',
	'boolean',
	'date',
	'json',
];

/** `YYYY-MM-DD`, with a time (`T00:00:00`, and what follows it) or without. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?$/;

/**
 * Which input edits a value. A boolean is a checkbox, a number a number input, a string that
 * is a date (`2026-01-02`, `2026-01-02T03:04:05Z`) a date input, an array or an object a JSON
 * text area; anything else, `null` too, is text.
 * @param value - The value of a key
 * @example
 * ```ts
 * kindOf(true); // 'boolean'
 * kindOf('2026-01-02'); // 'date'
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
 * in UTC (what a date input shows is a day, and a time of day is dropped), and a JSON text
 * area takes indented JSON.
 * @param value - The value of a key
 * @param kind - The kind of the input
 * @example
 * ```ts
 * draftOf('2026-01-02T23:00:00Z', 'date'); // '2026-01-02'
 * draftOf({ a: 1 }, 'json'); // '{\n  "a": 1\n}'
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
	return toText(value);
}

/** What typing made of a draft: a value to write, or the reason there is none yet. */
export type Parsed =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly reason: string };

/**
 * The value a draft is, for the kind of its input. An empty number is `null`; JSON is
 * parsed, and a text that is not JSON is not a value (the input stays open until it is, as
 * in BurgerEditor); a JSON text that is a number or a string makes the value that type.
 * @param kind - The kind of the input
 * @param draft - The text of the input
 * @example
 * ```ts
 * parseDraft('number', ''); // { ok: true, value: null }
 * parseDraft('json', '{'); // { ok: false, reason: ... }
 * ```
 */
export function parseDraft(kind: FieldKind, draft: string): Parsed {
	switch (kind) {
		case 'number': {
			if (draft.trim() === '') {
				return { ok: true, value: null };
			}
			const value = Number(draft);
			return Number.isFinite(value)
				? { ok: true, value }
				: { ok: false, reason: `"${draft}" is not a number` };
		}
		case 'json': {
			try {
				return { ok: true, value: JSON.parse(draft) as unknown };
			} catch (error) {
				return {
					ok: false,
					reason: `not JSON yet: ${error instanceof Error ? error.message : String(error)}`,
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
		case 'json': {
			return [];
		}
		default: {
			return '';
		}
	}
}
