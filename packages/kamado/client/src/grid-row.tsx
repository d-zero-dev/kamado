import type { Translate } from './i18n/translate.js';
import type { EnumOption, KindsSettings } from './logic/kinds.js';
import type { FieldKind } from './logic/value.js';
import type { Row as PageRow } from './types.js';

import { memo, useRef, useState } from 'react';

import { EnumEditor } from './enum-editor.js';
import { useI18n } from './i18n/context.js';
import { ListEditor } from './list-editor.js';
import { editKindOf } from './logic/columns.js';
import { enumKindOf } from './logic/kinds.js';
import { columnName } from './logic/layout.js';
import { parseDraft, toText } from './logic/value.js';

/** The cell being edited. A new object for each edit, so that typing does not make rows redraw. */
export interface Editing {
	/** The page the cell is of, by its URL (its place in the list can change under the edit). */
	readonly url: string;
	/** The identifier of the column (`url`, or `meta:<key>`): the column can move under the edit. */
	readonly column: string;
	readonly kind: FieldKind;
	readonly draft: string;
	/** The name the input has for people who cannot see the column. */
	readonly label: string;
	/** For an enum: what the cell offers (the options of the column, and the values it holds). */
	readonly choices?: readonly EnumOption[];
	/** For an enum: what is chosen now. */
	readonly selected?: readonly EnumOption[];
	/** For an enum: whether several can be chosen (the value is a list). */
	readonly multiple?: boolean;
}

interface EditorProps {
	readonly editing: Editing;
	readonly onCommit: (draft: string) => void;
	readonly onCancel: () => void;
	readonly onInvalid: (reason: string) => void;
}

/**
 * The input of the cell being edited. Enter (Ctrl+Enter in the JSON text area, where Enter is
 * a new line) and leaving the cell write the value; Escape drops it. JSON that does not parse
 * yet is not written: the input stays, and says why. A list and an enum have editors of their
 * own (`ListEditor`, `EnumEditor`), which write through the same rules.
 * @param root0 - The props
 * @param root0.editing - The cell being edited
 * @param root0.onCommit - Called with the text, once, when it is to be written
 * @param root0.onCancel - Called once when the edit is dropped
 * @param root0.onInvalid - Called with why the text is not a value yet
 */
function Editor({ editing, onCommit, onCancel, onInvalid }: EditorProps) {
	const { t } = useI18n();
	const [draft, setDraft] = useState(editing.draft);
	// A commit by Enter must not be repeated by the blur that follows when the input goes.
	const settled = useRef(false);
	const input = useRef<HTMLInputElement>(null);

	const cancel = () => {
		if (settled.current) {
			return;
		}
		settled.current = true;
		onCancel();
	};
	/**
	 * Why the text is not a value yet, or `null`.
	 * @param text - What was typed
	 */
	const problemOf = (text: string): string | null => {
		// A number input that holds text which is not a number (`1e`, `-`) reports an empty
		// value: read as that, the number would be erased.
		if (editing.kind === 'number' && input.current?.validity.badInput === true) {
			return t('edit.notANumber');
		}
		const parsed = parseDraft(editing.kind, text, t);
		return parsed.ok ? null : parsed.reason;
	};
	/**
	 * Writes the text, once. Enter that does not make a value keeps the editor open and says
	 * why; leaving the cell with such a text drops the edit and says so, for an editor that
	 * stays open without the focus can only be left by going back into it.
	 * @param text - What was typed
	 * @param leaving - Whether the cell is being left (blur) rather than confirmed (Enter)
	 */
	const commit = (text: string, leaving: boolean) => {
		if (settled.current) {
			return;
		}
		const problem = problemOf(text);
		if (problem !== null) {
			if (leaving) {
				onInvalid(t('edit.notSaved', { reason: problem }));
				cancel();
			} else {
				onInvalid(problem);
			}
			return;
		}
		settled.current = true;
		onCommit(text);
	};

	if (editing.kind === 'list') {
		return (
			<ListEditor
				label={editing.label}
				draft={editing.draft}
				commit={commit}
				cancel={cancel}
				invalid={onInvalid}
			/>
		);
	}
	if (editing.kind === 'enum') {
		return (
			<EnumEditor
				label={editing.label}
				choices={editing.choices ?? []}
				selected={editing.selected ?? []}
				multiple={editing.multiple === true}
				commit={commit}
				cancel={cancel}
			/>
		);
	}
	if (editing.kind === 'json') {
		return (
			<textarea
				autoFocus
				aria-label={editing.label}
				className="editor"
				rows={4}
				value={draft}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={() => commit(draft, true)}
				onKeyDown={(event) => {
					event.stopPropagation();
					// The Enter that confirms a conversion of an input method is not ours.
					if (event.nativeEvent.isComposing) {
						return;
					}
					if (event.key === 'Escape') {
						cancel();
					} else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
						event.preventDefault();
						commit(draft, false);
					}
				}}
			/>
		);
	}
	const type =
		editing.kind === 'number' ? 'number' : editing.kind === 'date' ? 'date' : 'text';
	return (
		<input
			ref={input}
			autoFocus
			aria-label={editing.label}
			className="editor"
			type={type}
			step={type === 'number' ? 'any' : undefined}
			value={draft}
			onFocus={(event) => {
				// What is typed replaces the value, as in a spreadsheet; the arrow keys
				// then put the cursor in it to change a part.
				if (type === 'text') {
					event.target.select();
				}
			}}
			// A date is written on Enter or when the cell is left, like the rest: a date input
			// reports a change as soon as a digit of the year is typed (`0002-01-02`), and
			// writing that would write the first key typed.
			onChange={(event) => setDraft(event.target.value)}
			onBlur={() => commit(draft, true)}
			onKeyDown={(event) => {
				event.stopPropagation();
				// The Enter that confirms a conversion of an input method is not ours.
				if (event.nativeEvent.isComposing) {
					return;
				}
				if (event.key === 'Escape') {
					cancel();
				} else if (event.key === 'Enter') {
					event.preventDefault();
					commit(draft, false);
				}
			}}
		/>
	);
}

interface RowProps {
	readonly row: PageRow;
	/** The row's place in what is shown, from 0. */
	readonly index: number;
	/** The row's place in the whole list, from 1 (the header is row 1 of the grid). */
	readonly ariaIndex: number;
	/** The identifiers of the columns, left to right. */
	readonly columns: readonly string[];
	/** How many of the first columns are pinned to the left edge. */
	readonly pinnedCount: number;
	/** The kinds of keys added on the screen, and of keys whose values are booleans, for a page that has none. */
	readonly addedKinds: ReadonlyMap<string, FieldKind>;
	/** The columns that are an enum. */
	readonly kinds: KindsSettings | undefined;
	/** The column that has the focus in this row, or -1 when the focus is in another row. */
	readonly activeCol: number;
	/** The cell being edited, when it is in this row. */
	readonly editing: Editing | null;
	readonly onCommit: (draft: string) => void;
	readonly onCancel: () => void;
	readonly onInvalid: (reason: string) => void;
}

/**
 * The text of a cell and what it says about itself: the origin of a metadata value, or why
 * it cannot be edited.
 * @param row - The row
 * @param column - The identifier of the column
 * @param addedKinds - The kinds of keys added on the screen, and of keys of booleans
 * @param kinds - The columns that are an enum
 * @param t - Says the words of the cell in the language of the screen
 */
function describe(
	row: PageRow,
	column: string,
	addedKinds: ReadonlyMap<string, FieldKind>,
	kinds: KindsSettings | undefined,
	t: Translate,
): {
	text: string;
	readOnly: boolean;
	note: string | undefined;
	origin?: string;
	/** For a boolean: whether it is checked (a page without the key is not). */
	checked?: boolean;
} {
	if (column === 'url') {
		return { text: row.url, readOnly: false, note: undefined };
	}
	if (column === 'virtual') {
		return { text: row.virtual ? t('row.virtual') : '', readOnly: true, note: undefined };
	}
	if (column === 'inputPath') {
		return { text: row.inputPath ?? '', readOnly: true, note: undefined };
	}
	const key = columnName(column);
	const { cell, kind } = editKindOf(row, key, addedKinds, enumKindOf(kinds, column));
	// A boolean is drawn as a check box, and an enum column of booleans is a choice (text).
	const checked = kind === 'boolean' ? cell?.value === true : undefined;
	if (cell === undefined) {
		return {
			text: '',
			readOnly: false,
			note: undefined,
			...(checked === undefined ? {} : { checked }),
		};
	}
	return {
		text: toText(cell.value),
		readOnly: !cell.editable,
		note: cell.editable
			? t('row.from', { origin: t(`origin.${cell.origin}` as const) })
			: cell.reason,
		origin: cell.origin,
		...(checked === undefined ? {} : { checked }),
	};
}

/**
 * One row of the grid. Memoised: the props are what the row shows, and a row that is neither
 * the one with the focus nor the one being edited is the same object as it was, so it is not
 * drawn again when the focus moves, or while a value is typed.
 */
export const GridRow = memo(function GridRow({
	row,
	index,
	ariaIndex,
	columns,
	pinnedCount,
	addedKinds,
	kinds,
	activeCol,
	editing,
	onCommit,
	onCancel,
	onInvalid,
}: RowProps) {
	const { t } = useI18n();
	const cells = [];
	for (const [col, column] of columns.entries()) {
		const { text, readOnly, note, origin, checked } = describe(
			row,
			column,
			addedKinds,
			kinds,
			t,
		);
		const isEditing = editing !== null && editing.column === column;
		const pinned = col < pinnedCount;
		cells.push(
			<div
				key={column}
				role="gridcell"
				id={`c-${index}-${col}`}
				data-row={index}
				data-col={col}
				aria-colindex={col + 1}
				aria-readonly={readOnly || undefined}
				aria-description={readOnly ? note : undefined}
				title={note ?? (text === '' ? undefined : text)}
				// A pinned cell sticks at the distance the grid sets in `--pin-<place>` (the widths
				// change while a column is dragged, and the rows are not drawn again for it).
				style={pinned ? { left: `var(--pin-${col})` } : undefined}
				className={`cell${pinned ? ' pinned' : ''}${col === pinnedCount - 1 ? ' pin-end' : ''}${col === activeCol ? ' active' : ''}${readOnly ? ' readonly' : ''}${origin === undefined ? '' : ` origin-${origin}`}`}>
				{isEditing ? (
					<Editor
						editing={editing}
						onCommit={onCommit}
						onCancel={onCancel}
						onInvalid={onInvalid}
					/>
				) : checked === undefined ? (
					text
				) : (
					<>
						{/* The box is for the eye and the pointer (a click on it makes the edit, see `data-toggle`);
						    the cell says `true` or `false` to a screen reader (a gridcell has no checked state to use). */}
						<span
							aria-hidden="true"
							className="check"
							data-toggle=""
							data-checked={checked}
						/>
						<span className="sr-only">{String(checked)}</span>
					</>
				)}
			</div>,
		);
	}
	return (
		<div role="row" aria-rowindex={ariaIndex} className="row">
			{cells}
		</div>
	);
});
