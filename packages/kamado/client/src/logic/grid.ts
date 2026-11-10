/** Where the focus is in the grid: a row and a column, counted from 0 in what is shown. */
export interface Position {
	readonly row: number;
	readonly col: number;
}

/**
 * Where a key takes the focus (the keys of the grid pattern of ARIA: the arrows, Home and
 * End, with Ctrl the first and last cell, Page Up and Page Down by a screenful). A key that
 * does not move the focus, or would move it out of the grid, leaves it where it is.
 * @param at - The cell now
 * @param key - `KeyboardEvent.key`
 * @param ctrl - Whether Ctrl (or Meta) is down
 * @param size - Rows and columns shown, and the rows a screenful is
 * @param size.rows
 * @param size.cols
 * @param size.screen
 * @returns The cell after the key (`at` itself when nothing moves)
 * @example
 * ```ts
 * nextCell({ row: 0, col: 0 }, 'ArrowDown', false, { rows: 10, cols: 4, screen: 5 });
 * // { row: 1, col: 0 }
 * ```
 */
export function nextCell(
	at: Position,
	key: string,
	ctrl: boolean,
	size: { readonly rows: number; readonly cols: number; readonly screen: number },
): Position {
	const lastRow = size.rows - 1;
	const lastCol = size.cols - 1;
	if (lastRow < 0 || lastCol < 0) {
		return at;
	}
	const clamp = (n: number, max: number) => Math.min(Math.max(n, 0), max);
	switch (key) {
		case 'ArrowUp': {
			return { row: clamp(at.row - 1, lastRow), col: at.col };
		}
		case 'ArrowDown': {
			return { row: clamp(at.row + 1, lastRow), col: at.col };
		}
		case 'ArrowLeft': {
			return { row: at.row, col: clamp(at.col - 1, lastCol) };
		}
		case 'ArrowRight': {
			return { row: at.row, col: clamp(at.col + 1, lastCol) };
		}
		case 'Home': {
			return ctrl ? { row: 0, col: 0 } : { row: at.row, col: 0 };
		}
		case 'End': {
			return ctrl ? { row: lastRow, col: lastCol } : { row: at.row, col: lastCol };
		}
		case 'PageUp': {
			return { row: clamp(at.row - size.screen, lastRow), col: at.col };
		}
		case 'PageDown': {
			return { row: clamp(at.row + size.screen, lastRow), col: at.col };
		}
		default: {
			return at;
		}
	}
}

/**
 * How many pages `total` rows make.
 * @param total - Rows in all
 * @param size - Rows a page shows
 * @example
 * ```ts
 * pageCount(0, 500); // 1
 * pageCount(1001, 500); // 3
 * ```
 */
export function pageCount(total: number, size: number): number {
	return Math.max(1, Math.ceil(total / size));
}

/**
 * The page (counted from 0) a page number is held to: an edit that removes rows, or a
 * search that finds fewer, can leave the page that was shown past the end.
 * @param page - The page wanted
 * @param total - Rows in all
 * @param size - Rows a page shows
 * @example
 * ```ts
 * clampPage(9, 1001, 500); // 2
 * ```
 */
export function clampPage(page: number, total: number, size: number): number {
	return Math.min(Math.max(page, 0), pageCount(total, size) - 1);
}

/**
 * What the screen says of the rows in view, for people and for screen readers.
 * @param offset - The first row's place in all the rows, from 0
 * @param shown - Rows in view
 * @param total - Rows in all
 * @example
 * ```ts
 * rangeLabel(500, 500, 1234); // '501–1,000 / 1,234'
 * rangeLabel(0, 0, 0); // '0 / 0'
 * ```
 */
export function rangeLabel(offset: number, shown: number, total: number): string {
	const all = total.toLocaleString('en-US');
	return shown === 0
		? `0 / ${all}`
		: `${(offset + 1).toLocaleString('en-US')}–${(offset + shown).toLocaleString('en-US')} / ${all}`;
}
