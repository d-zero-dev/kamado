/**
 * The kinds a column can be given (an enum: its values are chosen from a few options) and what
 * the screen does with the options: which ones a cell offers, what a choice makes of the value,
 * whether the options can be kept, and the kinds as the settings hold them. None of it touches
 * the DOM, so that it is shown by tests.
 *
 * The limits are those of the server (`settings.ts`, which this module cannot import: the
 * screen is built apart); `settings-kinds.spec.ts` compares the two.
 */

/**
 * The most options a column has: far more than a person chooses from.
 * @example
 * ```ts
 * optionsProblem(Array.from({ length: MAX_ENUM_OPTIONS + 1 }, (_, n) => n)); // 'tooMany'
 * ```
 */
export const MAX_ENUM_OPTIONS = 200;

/**
 * The longest an option that is text may be, in UTF-16 code units (what `String#length` counts).
 * @example
 * ```ts
 * optionsProblem(['x'.repeat(MAX_ENUM_OPTION_LENGTH + 1)]); // 'tooLong'
 * ```
 */
export const MAX_ENUM_OPTION_LENGTH = 200;

/**
 * The most bytes the kinds of all the columns are as JSON in UTF-8. It leaves room in the 64 KiB
 * of a change of the settings next to the layout of the columns.
 * @example
 * ```ts
 * kindsBytes(kinds) <= MAX_KINDS_BYTES; // what the server accepts
 * ```
 */
export const MAX_KINDS_BYTES = 12 * 1024;

/**
 * An option of an enum: text, a finite number, or a boolean.
 * @example
 * ```ts
 * const options: EnumOption[] = ['wide', 2, true];
 * ```
 */
export type EnumOption = string | number | boolean;

/**
 * The kind of a column that is an enum, with the options a value is chosen from.
 * @example
 * ```ts
 * const kind: EnumKind = { type: 'enum', options: ['wide', 'narrow'] };
 * ```
 */
export interface EnumKind {
	readonly type: 'enum';
	readonly options: readonly EnumOption[];
}

/**
 * The kinds of the columns that are an enum, by the identifier of the column (`meta:<key>`).
 * @example
 * ```ts
 * const kinds: KindsSettings = { 'meta:layout': { type: 'enum', options: ['wide'] } };
 * ```
 */
export type KindsSettings = Readonly<Record<string, EnumKind>>;

/**
 * Why a text is not an option of the kind it was typed as.
 * @example
 * ```ts
 * optionOf('', 'text'); // { ok: false, reason: 'empty' as OptionTextProblem }
 * ```
 */
export type OptionTextProblem = 'empty' | 'number' | 'boolean';

/**
 * Why options cannot be kept.
 * @example
 * ```ts
 * optionsProblem(['a', 'a']); // 'duplicate' as OptionsProblem
 * ```
 */
export type OptionsProblem =
	| 'none'
	| 'invalid'
	| 'tooMany'
	| 'tooLong'
	| 'duplicate'
	| 'bytes';

/**
 * Whether a value can be an option.
 * @param value - Any value
 */
function isOption(value: unknown): value is EnumOption {
	return typeof value === 'string'
		? value.length <= MAX_ENUM_OPTION_LENGTH
		: typeof value === 'number'
			? Number.isFinite(value)
			: typeof value === 'boolean';
}

/**
 * How an option is told from the others: as JSON, which keeps the number 1 and the text "1"
 * apart.
 * @param option - An option
 * @example
 * ```ts
 * optionKey(1); // '1'
 * optionKey('1'); // '"1"'
 * ```
 */
export function optionKey(option: EnumOption): string {
	return JSON.stringify(option);
}

/**
 * How a cell editor names an option. A text that would read as a number or a boolean is quoted,
 * so that the number 1 and the text "1" (two options) do not look the same in a list of choices.
 * @param option - An option
 * @example
 * ```ts
 * optionLabel('wide'); // 'wide'
 * optionLabel(1); // '1'
 * optionLabel('1'); // '"1"'
 * ```
 */
export function optionLabel(option: EnumOption): string {
	const readsAsOther =
		typeof option === 'string' &&
		(option === 'true' ||
			option === 'false' ||
			(option.trim() !== '' && Number.isFinite(Number(option))));
	return readsAsOther ? JSON.stringify(option) : String(option);
}

/**
 * What a cell holds, as a list of what is chosen in it: the items of an array, a value that is
 * one, or nothing.
 * @param value - The value of the cell
 * @example
 * ```ts
 * selectedOf(['a', 'b']); // ['a', 'b']
 * selectedOf('a'); // ['a']
 * selectedOf(null); // []
 * ```
 */
export function selectedOf(value?: unknown): EnumOption[] {
	const items = Array.isArray(value) ? (value as unknown[]) : [value];
	const kept: EnumOption[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		if (
			typeof item === 'string' ||
			typeof item === 'number' ||
			typeof item === 'boolean'
		) {
			const key = optionKey(item);
			if (!seen.has(key)) {
				seen.add(key);
				kept.push(item);
			}
		}
	}
	return kept;
}

/**
 * What a cell of an enum column offers: the options, and then the values the cell holds that
 * are not among them (a value is shown, and not rewritten by the options that do not have it).
 * @param options - The options of the column
 * @param value - The value of the cell
 * @example
 * ```ts
 * choicesOf(['a', 'b'], 'c'); // ['a', 'b', 'c']
 * choicesOf(['a', 'b'], 'b'); // ['a', 'b']
 * ```
 */
export function choicesOf(options: readonly EnumOption[], value?: unknown): EnumOption[] {
	const seen = new Set(options.map((option) => optionKey(option)));
	const choices = [...options];
	for (const item of selectedOf(value)) {
		const key = optionKey(item);
		if (!seen.has(key)) {
			seen.add(key);
			choices.push(item);
		}
	}
	return choices;
}

/**
 * The choices that are chosen once `option` is turned on or off. They keep the order of the
 * choices, whatever order they were chosen in, so that the same selection is the same list.
 * @param choices - What the cell offers
 * @param selected - What is chosen
 * @param option - The option that was turned on or off
 * @example
 * ```ts
 * toggled(['a', 'b', 'c'], ['c'], 'a'); // ['a', 'c']
 * toggled(['a', 'b', 'c'], ['a', 'c'], 'a'); // ['c']
 * ```
 */
export function toggled(
	choices: readonly EnumOption[],
	selected: readonly EnumOption[],
	option: EnumOption,
): EnumOption[] {
	const chosen = new Set(selected.map((item) => optionKey(item)));
	const key = optionKey(option);
	if (chosen.has(key)) {
		chosen.delete(key);
	} else {
		chosen.add(key);
	}
	return choices.filter((choice) => chosen.has(optionKey(choice)));
}

/**
 * Sets an own data property: `kinds['meta:__proto__']` is a name like another, but a key
 * `__proto__` alone must not set a prototype.
 * @param target - The object
 * @param key - The key
 * @param value - The value
 */
function setOwn(target: Record<string, EnumKind>, key: string, value: EnumKind): void {
	Object.defineProperty(target, key, {
		value,
		enumerable: true,
		writable: true,
		configurable: true,
	});
}

/** The column of the layout of a page. */
const LAYOUT_COLUMN = 'meta:layout';

/**
 * Whether the options of a column are the files in `pages.layouts.dir` and not something a
 * person sets: the `layout` column, when the site has a layouts directory.
 * @param id - The identifier of the column
 * @param layouts - The names of the layouts (`null` or `undefined` when the site has no
 * layouts directory)
 * @example
 * ```ts
 * optionsFromFiles('meta:layout', ['wide']); // true
 * optionsFromFiles('meta:layout', null); // false
 * ```
 */
export function optionsFromFiles(
	id: string,
	layouts?: readonly string[] | null,
): boolean {
	return id === LAYOUT_COLUMN && layouts !== null && layouts !== undefined;
}

/**
 * The kind of a column, when it is an enum. The `layout` column of a site that has a layouts
 * directory is an enum of the names of the files there, whatever the settings keep.
 * @param kinds - The kinds of the settings (or `undefined` when there are none)
 * @param id - The identifier of the column
 * @param layouts - The names of the layouts, when the site has a layouts directory
 * @example
 * ```ts
 * enumKindOf({ 'meta:layout': { type: 'enum', options: ['wide'] } }, 'meta:layout');
 * // { type: 'enum', options: ['wide'] }
 * enumKindOf(undefined, 'meta:layout', ['sub']); // { type: 'enum', options: ['sub'] }
 * ```
 */
export function enumKindOf(
	kinds: KindsSettings | undefined,
	id: string,
	layouts?: readonly string[] | null,
): EnumKind | undefined {
	if (optionsFromFiles(id, layouts)) {
		return { type: 'enum', options: layouts ?? [] };
	}
	return kinds !== undefined && Object.hasOwn(kinds, id) ? kinds[id] : undefined;
}

/**
 * The kinds with a column's kind set to an enum of `options`, or taken away (`null`). The kinds
 * that were given are not changed.
 * @param kinds - The kinds now
 * @param id - The identifier of the column
 * @param options - The options, or `null` to take the kind away
 * @example
 * ```ts
 * withKind({}, 'meta:layout', ['wide']); // { 'meta:layout': { type: 'enum', options: ['wide'] } }
 * withKind({ 'meta:layout': { type: 'enum', options: ['wide'] } }, 'meta:layout', null); // {}
 * ```
 */
export function withKind(
	kinds: KindsSettings,
	id: string,
	options: readonly EnumOption[] | null,
): KindsSettings {
	const next: Record<string, EnumKind> = {};
	for (const [key, kind] of Object.entries(kinds)) {
		if (key !== id) {
			setOwn(next, key, kind);
		}
	}
	if (options !== null) {
		setOwn(next, id, { type: 'enum', options: [...options] });
	}
	return next;
}

/**
 * What the screen sends to keep the kinds: `null` when no column is an enum (the server keeps
 * nothing then, as it does for `{}`).
 * @param kinds - The kinds
 * @example
 * ```ts
 * kindsPatch({}); // null
 * ```
 */
export function kindsPatch(kinds: KindsSettings): KindsSettings | null {
	return Object.keys(kinds).length === 0 ? null : kinds;
}

/**
 * The bytes the kinds are as JSON in UTF-8: what the server counts against
 * {@link MAX_KINDS_BYTES}.
 * @param kinds - The kinds
 * @example
 * ```ts
 * kindsBytes({}); // 2
 * ```
 */
export function kindsBytes(kinds: KindsSettings): number {
	return new TextEncoder().encode(JSON.stringify(kinds)).length;
}

/**
 * Why `options` cannot be kept for a column, or `null` when they can. The checks are those of the
 * server, so that what the dialog accepts is not refused with a `400`.
 * @param options - The options
 * @param id - The column they are for, to count them against the bytes of the other columns
 * @param kinds - The kinds the other columns have now (the one of `id` is replaced)
 * @example
 * ```ts
 * optionsProblem(['a', 'a']); // 'duplicate'
 * optionsProblem(['a', 'b']); // null
 * ```
 */
export function optionsProblem(
	options: readonly unknown[],
	id?: string,
	kinds?: KindsSettings,
): OptionsProblem | null {
	if (options.length === 0) {
		return 'none';
	}
	if (options.length > MAX_ENUM_OPTIONS) {
		return 'tooMany';
	}
	if (options.some((option) => typeof option === 'string' && !isOption(option))) {
		return 'tooLong';
	}
	if (!options.every((option) => isOption(option))) {
		return 'invalid';
	}
	if (new Set(options.map((option) => optionKey(option))).size !== options.length) {
		return 'duplicate';
	}
	if (
		id !== undefined &&
		kindsBytes(withKind(kinds ?? {}, id, options)) > MAX_KINDS_BYTES
	) {
		return 'bytes';
	}
	return null;
}

/**
 * The options the values of a column make: the text, numbers and booleans of the answer of the
 * core, in its order (the most often first), once each, up to the most options there may be.
 * An empty text is not offered: a choice of nothing would be a way to erase the value.
 * @param values - `values` of the answer of `GET /api/values`
 * @example
 * ```ts
 * optionsFromValues([{ value: 'wide', count: 3 }, { value: null, count: 1 }]); // ['wide']
 * ```
 */
export function optionsFromValues(
	values: readonly { readonly value: unknown; readonly count: number }[],
): EnumOption[] {
	const options: EnumOption[] = [];
	const seen = new Set<string>();
	for (const { value } of values) {
		if (options.length >= MAX_ENUM_OPTIONS) {
			break;
		}
		if (!isOption(value) || value === '') {
			continue;
		}
		const key = optionKey(value);
		if (!seen.has(key)) {
			seen.add(key);
			options.push(value);
		}
	}
	return options;
}

/**
 * The options after the values of the pages are added to them: the options as they were, then
 * the values that are not among them, up to the most options there may be. `more` says how many
 * values the pages have when not all of them are in the options (the request was cut, or a
 * value cannot be an option, or there was no room), and is `null` when all are.
 * @param keep - The options now
 * @param values - `values` of the answer of `GET /api/values`
 * @param total - `total` of the answer: how many different values the pages have
 * @example
 * ```ts
 * mergeOptions(['a'], [{ value: 'b', count: 2 }], 1); // { options: ['a', 'b'], more: null }
 * ```
 */
export function mergeOptions(
	keep: readonly EnumOption[],
	values: readonly { readonly value: unknown; readonly count: number }[],
	total: number,
): { options: EnumOption[]; more: { total: number; shown: number } | null } {
	const fromPages = optionsFromValues(values);
	const known = new Set(keep.map((option) => optionKey(option)));
	const options = [
		...keep,
		...fromPages.filter((option) => !known.has(optionKey(option))),
	].slice(0, MAX_ENUM_OPTIONS);
	const have = new Set(options.map((option) => optionKey(option)));
	const shown = fromPages.filter((option) => have.has(optionKey(option))).length;
	return { options, more: total > shown ? { total, shown } : null };
}

/**
 * Whether two selections hold the same options, whatever the order.
 * @param a - A selection
 * @param b - Another
 * @example
 * ```ts
 * sameSelection(['b', 'a'], ['a', 'b']); // true
 * ```
 */
export function sameSelection(
	a: readonly EnumOption[],
	b: readonly EnumOption[],
): boolean {
	const keys = new Set(a.map((option) => optionKey(option)));
	return (
		keys.size === a.length &&
		a.length === b.length &&
		b.every((o) => keys.has(optionKey(o)))
	);
}

/**
 * The option a text typed in the dialog is, for the kind it was typed as.
 * @param text - What was typed
 * @param type - What the text is meant to be: text, a number, or a boolean (`true` or `false`)
 * @example
 * ```ts
 * optionOf('12', 'number'); // { ok: true, value: 12 }
 * optionOf('yes', 'boolean'); // { ok: false, reason: 'boolean' }
 * ```
 */
export function optionOf(
	text: string,
	type: 'text' | 'number' | 'boolean',
):
	| { readonly ok: true; readonly value: EnumOption }
	| { readonly ok: false; readonly reason: OptionTextProblem } {
	if (type === 'text') {
		return text === '' ? { ok: false, reason: 'empty' } : { ok: true, value: text };
	}
	const trimmed = text.trim();
	if (trimmed === '') {
		return { ok: false, reason: 'empty' };
	}
	if (type === 'number') {
		const value = Number(trimmed);
		return Number.isFinite(value) ? { ok: true, value } : { ok: false, reason: 'number' };
	}
	if (trimmed === 'true' || trimmed === 'false') {
		return { ok: true, value: trimmed === 'true' };
	}
	return { ok: false, reason: 'boolean' };
}
