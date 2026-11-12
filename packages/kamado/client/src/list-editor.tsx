import type { Item, ItemKind } from './logic/list-items.js';

import { useLayoutEffect, useRef, useState } from 'react';

import { useI18n } from './i18n/context.js';
import {
	addItem,
	changeItem,
	itemsFromJson,
	kindToAdd,
	moveItem,
	removeItem,
	valuesOf,
} from './logic/list-items.js';
import { useCommands } from './use-commands.js';

/** The control that has the focus after the list was changed: the one the person was on. */
type Focus =
	| { readonly item: number; readonly control: 'input' | 'up' | 'down' | 'remove' }
	| { readonly item: null; readonly control: 'add' | 'asJson' | 'asList' | 'json' };

interface ListEditorProps {
	/** The name the editor has for people who cannot see the column. */
	readonly label: string;
	/** The JSON of the list when the editor opened. */
	readonly draft: string;
	/** Writes the JSON: by Enter, or (`leaving`) because the focus went out of the editor. */
	readonly commit: (text: string, leaving: boolean) => void;
	/** Drops the edit. */
	readonly cancel: () => void;
	/** Says why what is typed is not a value yet. */
	readonly invalid: (reason: string) => void;
}

const KINDS: readonly ItemKind[] = ['text', 'number', 'boolean'];

/**
 * The editor of a list of text, numbers and booleans: an input for each item, with buttons to
 * move it and take it away, and a button to add one. Enter (in an item) writes the list, leaving
 * the editor writes it, Escape drops the edit, as in the other editors. The list can be turned
 * into its JSON, for what the items cannot say (an item that is an object); the JSON can be
 * turned back into items when it is still a list of text, numbers and booleans.
 * @param props - The editor's props
 * @param props.label - The name the editor has for people who cannot see the column
 * @param props.draft - The JSON of the list when the editor opened
 * @param props.commit - Called with the JSON to write
 * @param props.cancel - Called when the edit is dropped
 * @param props.invalid - Called with why an item is not a value yet
 */
export function ListEditor({ label, draft, commit, cancel, invalid }: ListEditorProps) {
	const { t } = useI18n();
	const [items, setItems] = useState<Item[]>(() => itemsFromJson(draft) ?? []);
	const [asJson, setAsJson] = useState(() => itemsFromJson(draft) === null);
	const [json, setJson] = useState(draft);
	const [newKind, setNewKind] = useState<ItemKind | null>(null);
	// Where the focus starts: the text area of JSON that is not a list of items, the button that
	// adds an item to an empty list, or (by `autoFocus`) the first item.
	const [focus, setFocus] = useState<Focus | null>(() => {
		const first = itemsFromJson(draft);
		if (first === null) {
			return { item: null, control: 'json' };
		}
		return first.length === 0 ? { item: null, control: 'add' } : null;
	});
	const root = useRef<HTMLDivElement>(null);

	// A control that was moved or taken away loses the focus, and the editor must not take that
	// for the focus leaving it: the focus is given back here, before the browser can say so.
	useLayoutEffect(() => {
		if (focus === null || root.current === null) {
			return;
		}
		const selector =
			focus.item === null
				? `[data-control="${focus.control}"]`
				: `[data-item="${focus.item}"] [data-control="${focus.control}"]`;
		root.current.querySelector<HTMLElement>(selector)?.focus();
		setFocus(null);
	}, [focus]);

	/**
	 * What the items are as JSON, or `null` after saying which item is not a value yet.
	 * @param leaving - Whether the editor is being left (the reason says the list was not saved)
	 */
	const jsonOfItems = (leaving: boolean): string | null => {
		const made = valuesOf(items);
		if (made.ok) {
			return JSON.stringify(made.values);
		}
		const reason = t('list.notANumber', { n: made.index + 1 });
		invalid(leaving ? t('edit.notSaved', { reason }) : reason);
		return null;
	};

	/**
	 * Writes the list.
	 * @param leaving - Whether the editor is being left rather than confirmed with Enter
	 */
	const write = (leaving: boolean) => {
		const text = asJson ? json : jsonOfItems(leaving);
		if (text === null) {
			if (leaving) {
				cancel();
			}
			return;
		}
		commit(text, leaving);
	};

	const toJson = () => {
		const made = valuesOf(items);
		if (made.ok) {
			setJson(JSON.stringify(made.values, null, 2));
			setAsJson(true);
			setFocus({ item: null, control: 'json' });
		} else {
			invalid(t('list.notANumber', { n: made.index + 1 }));
		}
	};

	const toList = () => {
		const back = itemsFromJson(json);
		if (back === null) {
			invalid(t('list.notAList'));
			return;
		}
		setItems(back);
		setAsJson(false);
		setFocus({ item: null, control: 'asJson' });
	};

	/**
	 * The item a button of the list belongs to, by the `data-item` of its line.
	 * @param button - The button that was pressed
	 */
	const itemOf = (button: HTMLElement) => {
		const id = Number(button.closest<HTMLElement>('[data-item]')?.dataset.item);
		return items.find((item) => item.id === id);
	};

	const commands = useCommands(
		{
			asList: toList,
			asJson: toJson,
			up: (button) => {
				const item = itemOf(button);
				if (item !== undefined) {
					setItems(moveItem(items, item.id, -1));
					setFocus({ item: item.id, control: 'up' });
				}
			},
			down: (button) => {
				const item = itemOf(button);
				if (item !== undefined) {
					setItems(moveItem(items, item.id, 1));
					setFocus({ item: item.id, control: 'down' });
				}
			},
			remove: (button) => {
				const item = itemOf(button);
				if (item === undefined) {
					return;
				}
				const index = items.indexOf(item);
				const next = removeItem(items, item.id);
				setItems(next);
				const after = next[index] ?? next[index - 1];
				setFocus(
					after === undefined
						? { item: null, control: 'add' }
						: { item: after.id, control: 'remove' },
				);
			},
			add: () => {
				const next = addItem(items, newKind ?? kindToAdd(items));
				setItems(next);
				const added = next.at(-1);
				if (added !== undefined) {
					setFocus({ item: added.id, control: 'input' });
				}
			},
		},
		root,
	);

	return (
		<div
			ref={commands.ref}
			id={commands.id}
			role="group"
			aria-label={label}
			// A button is not given the focus by a click in Safari, which gives it to the nearest
			// ancestor that can have it: without this the focus would go to the body, and a click on a
			// button of the editor would look like leaving it.
			tabIndex={-1}
			className="editor list-editor"
			onBlur={() => {
				// Looked at after the focus has settled: it goes through the body for a moment when a
				// control is taken away, and comes back.
				setTimeout(() => {
					if (root.current !== null && !root.current.contains(document.activeElement)) {
						write(true);
					}
				}, 0);
			}}
			onKeyDown={(event) => {
				event.stopPropagation();
				// The Enter that confirms a conversion of an input method is not ours.
				if (event.nativeEvent.isComposing) {
					return;
				}
				if (event.key === 'Escape') {
					cancel();
				} else if (
					event.key === 'Enter' &&
					(event.target instanceof HTMLInputElement ||
						(event.target instanceof HTMLTextAreaElement &&
							(event.ctrlKey || event.metaKey)))
				) {
					event.preventDefault();
					write(false);
				}
			}}>
			{asJson ? (
				<>
					<textarea
						data-control="json"
						aria-label={label}
						className="editor"
						rows={4}
						value={json}
						onChange={(event) => setJson(event.target.value)}
					/>
					<div className="list-actions">
						<button type="button" data-control="asList" {...commands.run('asList')}>
							{t('list.asList')}
						</button>
					</div>
				</>
			) : (
				<>
					{items.length === 0 && <span className="muted">{t('list.empty')}</span>}
					<ol className="list-items">
						{items.map((item, index) => (
							<li key={item.id} data-item={item.id}>
								{item.kind === 'boolean' ? (
									<input
										data-control="input"
										type="checkbox"
										autoFocus={index === 0}
										aria-label={t('list.item', { n: index + 1 })}
										checked={item.text === 'true'}
										onChange={(event) =>
											setItems(changeItem(items, item.id, String(event.target.checked)))
										}
									/>
								) : (
									<input
										data-control="input"
										type={item.kind === 'number' ? 'number' : 'text'}
										step={item.kind === 'number' ? 'any' : undefined}
										aria-label={t('list.item', { n: index + 1 })}
										value={item.text}
										autoFocus={index === 0}
										onChange={(event) =>
											setItems(changeItem(items, item.id, event.target.value))
										}
									/>
								)}
								<button
									type="button"
									data-control="up"
									aria-label={t('list.up', { n: index + 1 })}
									disabled={index === 0}
									{...commands.run('up')}>
									<span aria-hidden="true">↑</span>
								</button>
								<button
									type="button"
									data-control="down"
									aria-label={t('list.down', { n: index + 1 })}
									disabled={index === items.length - 1}
									{...commands.run('down')}>
									<span aria-hidden="true">↓</span>
								</button>
								<button
									type="button"
									data-control="remove"
									aria-label={t('list.remove', { n: index + 1 })}
									{...commands.run('remove')}>
									<span aria-hidden="true">✕</span>
								</button>
							</li>
						))}
					</ol>
					<div className="list-actions">
						<select
							aria-label={t('list.addKind')}
							value={newKind ?? kindToAdd(items)}
							onChange={(event) => setNewKind(event.target.value as ItemKind)}>
							{KINDS.map((kind) => (
								<option key={kind} value={kind}>
									{t(`kind.${kind}` as const)}
								</option>
							))}
						</select>
						<button type="button" data-control="add" {...commands.run('add')}>
							{t('list.add')}
						</button>
						<button type="button" data-control="asJson" {...commands.run('asJson')}>
							{t('list.asJson')}
						</button>
					</div>
				</>
			)}
		</div>
	);
}
