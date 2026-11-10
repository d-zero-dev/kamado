import type { EnumOption } from './logic/kinds.js';

import { useRef, useState } from 'react';

import { useI18n } from './i18n/context.js';
import { optionKey, optionLabel, sameSelection, toggled } from './logic/kinds.js';

interface EnumEditorProps {
	/** The name the editor has for people who cannot see the column. */
	readonly label: string;
	/** What the cell offers: the options of the column and the values the cell holds. */
	readonly choices: readonly EnumOption[];
	/** What is chosen now. */
	readonly selected: readonly EnumOption[];
	/** Whether several can be chosen (the value is a list). */
	readonly multiple: boolean;
	/** Writes the JSON of the choice (or the list of choices): by a choice, by Enter, or by leaving. */
	readonly commit: (text: string, leaving: boolean) => void;
	/** Drops the edit. */
	readonly cancel: () => void;
}

/**
 * The editor of a cell whose column is a choice among options. One value is a select: choosing
 * writes it. A list of values is a check box for each choice: Enter and leaving the editor write
 * the list, in the order of the choices; leaving it without touching a box drops the edit, so
 * that a list is not written again in another order. Escape drops the edit in both.
 * @param props - The editor's props
 * @param props.label - The name the editor has for people who cannot see the column
 * @param props.choices - What the cell offers
 * @param props.selected - What is chosen now
 * @param props.multiple - Whether several can be chosen
 * @param props.commit - Called with the JSON to write
 * @param props.cancel - Called when the edit is dropped
 */
export function EnumEditor({
	label,
	choices,
	selected,
	multiple,
	commit,
	cancel,
}: EnumEditorProps) {
	const { t } = useI18n();
	const [chosen, setChosen] = useState<readonly EnumOption[]>(selected);
	const root = useRef<HTMLDivElement>(null);

	if (!multiple) {
		const first = selected[0];
		const at =
			first === undefined
				? -1
				: choices.findIndex((c) => optionKey(c) === optionKey(first));
		return (
			<select
				autoFocus
				aria-label={label}
				className="editor"
				value={at < 0 ? '' : String(at)}
				onChange={(event) => {
					const choice = choices[Number(event.target.value)];
					if (choice !== undefined) {
						commit(JSON.stringify(choice), false);
					}
				}}
				// Leaving without a choice drops the edit; after a choice the edit is settled, and
				// this does nothing.
				onBlur={cancel}
				onKeyDown={(event) => {
					event.stopPropagation();
					if (event.key === 'Escape') {
						cancel();
					}
				}}>
				{at < 0 && (
					// Not a choice: it says nothing is chosen, and cannot be chosen.
					<option value="" disabled hidden>
						{t('enum.choose')}
					</option>
				)}
				{choices.map((choice, index) => (
					<option key={optionKey(choice)} value={index}>
						{optionLabel(choice)}
					</option>
				))}
			</select>
		);
	}

	// Written only when the set of what is chosen changed: a list that was turned on and off again
	// is the list it was, and writing it in the order of the choices would only reorder the file.
	const changed = () => !sameSelection(chosen, selected);
	const leave = () => {
		if (changed()) {
			commit(JSON.stringify(chosen), true);
		} else {
			cancel();
		}
	};
	return (
		<div
			ref={root}
			role="group"
			aria-label={label}
			// The group takes the focus when there is no box to (no choice), and when a click on a box
			// gives it to none in Safari: the focus would then go to the body, and a click on a box
			// would look like leaving the editor.
			tabIndex={-1}
			autoFocus={choices.length === 0}
			className="editor enum-editor"
			onBlur={() => {
				// After the focus has settled: it goes from one box to the next through nothing.
				setTimeout(() => {
					if (root.current !== null && !root.current.contains(document.activeElement)) {
						leave();
					}
				}, 0);
			}}
			onKeyDown={(event) => {
				event.stopPropagation();
				if (event.nativeEvent.isComposing) {
					return;
				}
				if (event.key === 'Escape') {
					cancel();
				} else if (event.key === 'Enter') {
					event.preventDefault();
					if (changed()) {
						commit(JSON.stringify(chosen), false);
					} else {
						cancel();
					}
				}
			}}>
			{choices.map((choice, index) => (
				<label key={optionKey(choice)}>
					<input
						type="checkbox"
						autoFocus={index === 0}
						checked={chosen.some((c) => optionKey(c) === optionKey(choice))}
						onChange={() => {
							setChosen(toggled(choices, chosen, choice));
						}}
					/>
					{optionLabel(choice)}
				</label>
			))}
		</div>
	);
}
