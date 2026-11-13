import type { Translate } from '../i18n/translate.js';
import type { CellDiff, Diffs, Origin, PageDiff } from '../types.js';

import { columnName } from './layout.js';

/** The most characters of a value of HEAD that a note quotes. */
const MAX_QUOTED = 80;

/**
 * The difference of the cell of a column from HEAD.
 * @param page - The differences of the page (`undefined` for a page that does not differ)
 * @param column - The identifier of the column (`url`, `inputPath`, `virtual`, `meta:<key>`)
 * @returns `undefined` when the cell does not differ, and for a column that has no difference to
 * show (`virtual`)
 * @example
 * ```ts
 * cellDiffOf({ meta: { title: { kind: 'modified', head: 'Old', revertible: true } } }, 'meta:title');
 * // { kind: 'modified', head: 'Old', revertible: true }
 * ```
 */
export function cellDiffOf(
	page: PageDiff | undefined,
	column: string,
): CellDiff | undefined {
	if (page === undefined) {
		return undefined;
	}
	if (column === 'url') {
		return page.url;
	}
	if (column === 'inputPath') {
		return page.inputPath;
	}
	if (!column.startsWith('meta:')) {
		return undefined;
	}
	const key = columnName(column);
	// A key is a name the site chose: `constructor` is not a difference.
	return page.meta !== undefined && Object.hasOwn(page.meta, key)
		? page.meta[key]
		: undefined;
}

/**
 * What a revert of a column names to the server: the key of the metadata, or `null` for the
 * `url` column (the key that makes the URL, when there is one).
 * @param column - The identifier of the column
 * @returns `null` when the column is put back by no key (the path of the file is not, as the file
 * of a page that HEAD does not have is not)
 * @example
 * ```ts
 * revertKeyOf('meta:title'); // { key: 'title' }
 * revertKeyOf('url'); // { key: null }
 * revertKeyOf('inputPath'); // null
 * ```
 */
export function revertKeyOf(column: string): { key: string | null } | null {
	if (column === 'url') {
		return { key: null };
	}
	return column.startsWith('meta:') ? { key: columnName(column) } : null;
}

/**
 * The differences once the answer for some pages is in: what was known of those pages is
 * replaced by it, and what was known of the others stays.
 * @param known - What is known of the window (`null` for nothing)
 * @param urls - The pages the answer is for
 * @param answer - What the server answered for them
 * @returns `null` when there is no answer, when nothing was known of the rest of the window (an
 * answer for some pages would show the bars of those and none of the others), and when it is for
 * another commit than the one the rest was compared with (the marks of the others are not of the
 * commit now). The caller asks for the whole window then
 * @example
 * ```ts
 * withPageDiff(known, ['/a/'], answerForA); // known, with the page '/a/' as the answer says
 * ```
 */
export function withPageDiff(
	known: Diffs | null,
	urls: readonly string[],
	answer: Diffs | null,
): Diffs | null {
	if (answer === null || known === null) {
		return null;
	}
	if (known.head.oid !== answer.head.oid) {
		return null;
	}
	const pages: Record<string, PageDiff> = { ...known.pages };
	for (const url of urls) {
		delete pages[url];
	}
	Object.assign(pages, answer.pages);
	// The same list while it holds the same keys: the columns of the screen are made from it.
	const columns = answer.columns.every((key) => known.columns.includes(key))
		? known.columns
		: [...new Set([...known.columns, ...answer.columns])];
	return { head: answer.head, version: answer.version, pages, columns };
}

/**
 * The small text under a value that is written in the sidecar or in `pages.overrides`. A value in
 * the page file (the most of them) has none, so that the exceptions are the ones that are seen.
 * @param origin - Where the value is written
 * @param t - Says the words in the language of the screen
 * @example
 * ```ts
 * originLabel('sidecar', t); // 'sidecar'
 * originLabel('inFile', t); // null
 * ```
 */
export function originLabel(origin: Origin, t: Translate): string | null {
	switch (origin) {
		case 'sidecar': {
			return t('origin.labelSidecar');
		}
		case 'overrides': {
			return t('origin.labelOverrides');
		}
		default: {
			return null;
		}
	}
}

/**
 * The file a value is written in, said as a name for a person.
 * @param origin - Where the value is written
 * @param overridesFile - The `pages.overrides` file, as the server named it (`null` for none)
 * @param t - Says the words in the language of the screen
 * @example
 * ```ts
 * originName('overrides', 'data/pages.overrides.json', t); // 'data/pages.overrides.json'
 * originName('inFile', null, t); // 'the page file'
 * ```
 */
export function originName(
	origin: Origin,
	overridesFile: string | null,
	t: Translate,
): string {
	return t(`origin.${origin}` as const, { file: overridesFile ?? 'pages.overrides' });
}

/**
 * The names of the files that putting a value back writes, for the dialog that asks before it is.
 * @param writes - The places the files are (`CellDiff.writes`)
 * @param overridesFile - The `pages.overrides` file, as the server named it (`null` for none)
 * @param t - Says the words in the language of the screen
 * @returns The names, in a list; `null` when the server did not say
 * @example
 * ```ts
 * writeNames(['inFile', 'sidecar'], null, t); // 'the page file, the sidecar (.json)'
 * ```
 */
export function writeNames(
	writes: readonly Origin[] | undefined,
	overridesFile: string | null,
	t: Translate,
): string | null {
	if (writes === undefined || writes.length === 0) {
		return null;
	}
	return writes.map((origin) => originName(origin, overridesFile, t)).join(', ');
}

/**
 * A value as a person reads it where it is quoted: a text as it is (an empty one in quotes, so
 * that it is seen), any other value as JSON.
 * @param value - The value; `undefined` for a cell that has none
 * @param none - What a cell with no value says
 * @example
 * ```ts
 * valueText('Old', '(none)'); // 'Old'
 * valueText('', '(none)'); // '""'
 * valueText(['a', 1], '(none)'); // '["a",1]'
 * valueText(undefined, '(none)'); // '(none)'
 * ```
 */
export function valueText(value: unknown, none: string): string {
	if (value === undefined) {
		return none;
	}
	if (typeof value === 'string') {
		return value === '' ? '""' : value;
	}
	// `JSON.stringify` has no text for a function or a symbol.
	// oxlint-disable-next-line typescript/no-base-to-string -- only a function or a symbol gets here, and an object has the JSON of it
	return JSON.stringify(value) ?? String(value);
}

/**
 * A value as a note quotes it: as `valueText` says it, and cut when it is long. It is cut between
 * characters and not between the halves of one that takes two units of a string.
 * @param value - The value
 */
function quoted(value: unknown): string {
	// oxlint-disable-next-line typescript/no-misused-spread -- the code points on purpose: a character of two units stays whole
	const characters = [...valueText(value, '')];
	return characters.length > MAX_QUOTED
		? `${characters.slice(0, MAX_QUOTED).join('')}…`
		: characters.join('');
}

/**
 * What a cell says of its difference from HEAD, for the tooltip and for screen readers: the
 * kind, the value HEAD holds, and how it is put back when it can be.
 * @param diff - The difference
 * @param t - Says the words in the language of the screen
 * @example
 * ```ts
 * diffNote({ kind: 'modified', head: 'Old', revertible: true }, t);
 * // 'Changed from HEAD (HEAD: Old). Alt+Backspace puts it back'
 * ```
 */
export function diffNote(diff: CellDiff, t: Translate): string {
	const note = t(`diff.note.${diff.kind}` as const, { head: quoted(diff.head) });
	return diff.revertible
		? t('diff.withHint', { note, hint: t('diff.revertHint') })
		: note;
}

/** What the screen does when a revert was refused (see {@link revertFailureOf}). */
export interface RevertFailure {
	/** What is said besides the message of the server; `null` when the message is enough. */
	readonly note: 'diff.headMoved' | 'diff.noHead' | null;
	/** Whether the list is read again from the files (the files are not what the screen read). */
	readonly rereadFiles: boolean;
	/** What is done with the marks of HEAD: kept, read again, or taken away. */
	readonly marks: 'keep' | 'read' | 'drop';
}

/**
 * What the screen does for the code of an answer that refused a revert.
 * @param code - The code of the error of the server
 * @example
 * ```ts
 * revertFailureOf('headMoved'); // { note: 'diff.headMoved', rereadFiles: false, marks: 'read' }
 * revertFailureOf('conflict'); // { note: null, rereadFiles: true, marks: 'keep' }
 * ```
 */
export function revertFailureOf(code: string): RevertFailure {
	switch (code) {
		case 'conflict': {
			// Reading the list again reads the marks with it.
			return { note: null, rereadFiles: true, marks: 'keep' };
		}
		case 'headMoved': {
			return { note: 'diff.headMoved', rereadFiles: false, marks: 'read' };
		}
		case 'noHead': {
			return { note: 'diff.noHead', rereadFiles: false, marks: 'drop' };
		}
		default: {
			return { note: null, rereadFiles: false, marks: 'keep' };
		}
	}
}
