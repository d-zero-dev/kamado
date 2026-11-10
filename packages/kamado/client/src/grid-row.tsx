import type { FieldKind } from './logic/value.js';
import type { Row as PageRow } from './types.js';

import { memo, useRef, useState } from 'react';

import { cellOf } from './logic/columns.js';
import { parseDraft, toText } from './logic/value.js';

/** The columns before the keys of the metadata: the URL, whether the page is virtual, its file. */
export const FIXED_COLUMNS = ['url', 'virtual', 'inputPath'] as const;

/** The cell being edited. A new object for each edit, so that typing does not make rows redraw. */
export interface Editing {
	/** The page the cell is of, by its URL (its place in the list can change under the edit). */
	readonly url: string;
	readonly col: number;
	readonly kind: FieldKind;
	readonly draft: string;
	/** The name the input has for people who cannot see the column. */
	readonly label: string;
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
 * yet is not written: the input stays, and says why.
 * @param root0 - The props
 * @param root0.editing - The cell being edited
 * @param root0.onCommit - Called with the text, once, when it is to be written
 * @param root0.onCancel - Called once when the edit is dropped
 * @param root0.onInvalid - Called with why the text is not a value yet
 */
function Editor({ editing, onCommit, onCancel, onInvalid }: EditorProps) {
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
			return 'what is typed is not a number';
		}
		const parsed = parseDraft(editing.kind, text);
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
				onInvalid(`Not saved: ${problem}`);
				cancel();
			} else {
				onInvalid(problem);
			}
			return;
		}
		settled.current = true;
		onCommit(text);
	};

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
	readonly columns: readonly string[];
	readonly addedKinds: ReadonlyMap<string, FieldKind>;
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
 * @param col - The column, from 0
 * @param columns - The keys of the metadata
 * @param addedKinds - The kinds of keys added on the screen
 */
function describe(
	row: PageRow,
	col: number,
	columns: readonly string[],
	addedKinds: ReadonlyMap<string, FieldKind>,
): { text: string; readOnly: boolean; note: string | undefined; origin?: string } {
	if (col === 0) {
		return { text: row.url, readOnly: false, note: undefined };
	}
	if (col === 1) {
		return { text: row.virtual ? 'virtual' : '', readOnly: true, note: undefined };
	}
	if (col === 2) {
		return { text: row.inputPath ?? '', readOnly: true, note: undefined };
	}
	const key = columns[col - FIXED_COLUMNS.length];
	if (key === undefined) {
		return { text: '', readOnly: true, note: undefined };
	}
	const { cell } = cellOf(row, key, addedKinds);
	if (cell === undefined) {
		return { text: '', readOnly: false, note: undefined };
	}
	return {
		text: toText(cell.value),
		readOnly: !cell.editable,
		note: cell.editable ? `from ${cell.origin}` : cell.reason,
		origin: cell.origin,
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
	addedKinds,
	activeCol,
	editing,
	onCommit,
	onCancel,
	onInvalid,
}: RowProps) {
	const cells = [];
	for (let col = 0; col < FIXED_COLUMNS.length + columns.length; col++) {
		const { text, readOnly, note, origin } = describe(row, col, columns, addedKinds);
		const isEditing = editing !== null && editing.col === col;
		cells.push(
			<div
				key={col}
				role="gridcell"
				id={`c-${index}-${col}`}
				data-row={index}
				data-col={col}
				aria-colindex={col + 1}
				aria-readonly={readOnly || undefined}
				aria-description={readOnly ? note : undefined}
				title={note ?? (text === '' ? undefined : text)}
				className={`cell${col === activeCol ? ' active' : ''}${readOnly ? ' readonly' : ''}${origin === undefined ? '' : ` origin-${origin}`}`}>
				{isEditing ? (
					<Editor
						editing={editing}
						onCommit={onCommit}
						onCancel={onCancel}
						onInvalid={onInvalid}
					/>
				) : (
					text
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
