import { useEffect, useId, useLayoutEffect, useRef } from 'react';

import { useCommands } from './use-commands.js';

/** One entry of a menu. */
export interface MenuItem {
	readonly id: string;
	readonly label: string;
	/** A disabled entry is shown and cannot be chosen. */
	readonly disabled?: boolean;
}

interface MenuProps {
	/** The name of the menu for people who cannot see it. */
	readonly label: string;
	/**
	 * A text that goes with the menu, shown above the entries (one line per line of it) and given
	 * to people who cannot see it as the description of the menu. Not an entry: the keys of the
	 * menu pass over it.
	 */
	readonly note?: string;
	/** Where it opens: under this point of the screen. */
	readonly anchor: { readonly left: number; readonly bottom: number };
	readonly items: readonly MenuItem[];
	/** Called with the id of the entry that was chosen. */
	readonly onChoose: (id: string) => void;
	/**
	 * Called when the menu is to go. `restoreFocus` is whether the focus goes back to where it was
	 * (a key closed the menu) or stays where the person clicked (a click outside did).
	 */
	readonly onClose: (restoreFocus: boolean) => void;
}

/**
 * A menu of actions on a column, opened by a button or by `Alt+↓` and used with the keyboard:
 * `↓` and `↑` (and Home and End) move among the entries, Enter or Space chooses, Escape closes it
 * and gives the focus back. A click outside closes it.
 * @param props - The menu
 * @param props.label - The name of the menu
 * @param props.note - A text shown above the entries
 * @param props.anchor - Where it opens: the left edge and the top edge of the menu, from the
 * left and the top of the window
 * @param props.items - The entries
 * @param props.onChoose - Called with the entry chosen
 * @param props.onClose - Called when the menu is to go
 */
export function ColumnMenu({ label, note, anchor, items, onChoose, onClose }: MenuProps) {
	const menu = useRef<HTMLDivElement>(null);
	const noteId = useId();

	// Kept inside the window: a column at the right edge opens its menu to the left of the point.
	useLayoutEffect(() => {
		const element = menu.current;
		if (element === null) {
			return;
		}
		const room = window.innerWidth - element.offsetWidth - 8;
		element.style.left = `${Math.max(8, Math.min(anchor.left, room))}px`;
		const height = window.innerHeight - element.offsetHeight - 8;
		element.style.top = `${Math.max(8, Math.min(anchor.bottom, height))}px`;
	}, [anchor]);

	// The focus is in the menu from the moment it opens, and goes back to the first entry when the
	// entry it was on is no longer one that can be chosen.
	useEffect(() => {
		const element = menu.current;
		const focused = document.activeElement as HTMLButtonElement | null;
		if (element !== null && (!element.contains(focused) || focused?.disabled === true)) {
			element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
		}
	}, [items]);

	useEffect(() => {
		const outside = (event: PointerEvent) => {
			const target = event.target as Element;
			// The button that opened the menu closes it with its own click: closing here as well
			// would let that click open the menu again.
			if (
				!menu.current?.contains(target) &&
				target.closest?.('[aria-haspopup="menu"][aria-expanded="true"]') === null
			) {
				onClose(false);
			}
		};
		// The menu does not follow the column when the grid scrolls: it goes instead.
		const away = () => onClose(false);
		document.addEventListener('pointerdown', outside, true);
		window.addEventListener('resize', away);
		document.addEventListener('scroll', away, true);
		return () => {
			document.removeEventListener('pointerdown', outside, true);
			window.removeEventListener('resize', away);
			document.removeEventListener('scroll', away, true);
		};
	}, [onClose]);

	const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		// The keys of the menu are not the keys of the grid under it.
		event.stopPropagation();
		// Tab leaves the menu and does not go round its entries: they are chosen with the arrows,
		// and a menu that stays open behind the focus is on the screen with no way back to it.
		if (event.key === 'Escape' || event.key === 'Tab') {
			event.preventDefault();
			onClose(true);
			return;
		}
		if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
			return;
		}
		event.preventDefault();
		const buttons = [
			...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ??
				[]),
		];
		const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
		let next: number;
		if (event.key === 'Home') {
			next = 0;
		} else if (event.key === 'End') {
			next = buttons.length - 1;
		} else {
			const step = event.key === 'ArrowDown' ? 1 : -1;
			next = (at + step + buttons.length) % buttons.length;
		}
		buttons[next]?.focus();
	};

	const commands = useCommands(
		{
			choose: (source) => {
				if (source.dataset.item !== undefined) {
					onChoose(source.dataset.item);
				}
			},
		},
		menu,
	);

	return (
		// The note is outside the element with `role="menu"`: the children of a menu are its
		// entries, and a paragraph among them is not one. The menu still points at it with
		// `aria-describedby`, which can name any element.
		<div
			ref={commands.ref}
			id={commands.id}
			className="column-menu"
			onKeyDown={onKeyDown}>
			{note !== undefined && (
				<p id={noteId} className="note">
					{note}
				</p>
			)}
			<div
				role="menu"
				aria-label={label}
				aria-describedby={note === undefined ? undefined : noteId}
				className="entries">
				{items.map((item) => (
					<button
						key={item.id}
						type="button"
						role="menuitem"
						tabIndex={-1}
						disabled={item.disabled}
						data-item={item.id}
						{...commands.run('choose')}>
						{item.label}
					</button>
				))}
			</div>
		</div>
	);
}
