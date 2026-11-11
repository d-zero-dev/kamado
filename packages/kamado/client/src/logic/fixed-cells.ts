/**
 * What the cells of the columns every row has hold: the URL, whether the page is virtual, its
 * file, and what the plan makes of the page (its place in the plan, the file it is written to,
 * the page above it, how deep it is). Which of them can be edited is said here, so that the
 * rule is tested without a browser: the grid only draws what {@link fixedCellOf} says.
 */
import type { Row } from '../types.js';

/**
 * A cell of a fixed column.
 * @example
 * ```ts
 * const cell: FixedCell = { text: '/about/', readOnly: false };
 * ```
 */
export interface FixedCell {
	/** What the cell shows (empty for a box). */
	readonly text: string;
	/** Whether the cell cannot be edited: what the plan makes of a page is changed by changing the page. */
	readonly readOnly: boolean;
	/** For a cell that is a box (`virtual`): whether it is checked. */
	readonly checked?: boolean;
}

/**
 * The cell of a fixed column of a row, or `null` for a column that is not one (a key of the
 * metadata).
 *
 * `url`, `inputPath` and `virtual` are edited: a URL moves the page, a path moves its file (or
 * gives a virtual page one, so the cell of a virtual page is edited too), and `virtual` is a
 * box that is turned over. `order`, `outputPath`, `parent` and `depth` are read only.
 * @param row - The page
 * @param column - The identifier of the column
 * @example
 * ```ts
 * fixedCellOf(row, 'virtual'); // { text: '', readOnly: false, checked: false }
 * fixedCellOf(row, 'order'); // { text: '3', readOnly: true }
 * fixedCellOf(row, 'meta:title'); // null
 * ```
 */
export function fixedCellOf(
	row: Pick<
		Row,
		'depth' | 'inputPath' | 'order' | 'outputPath' | 'parent' | 'url' | 'virtual'
	>,
	column: string,
): FixedCell | null {
	switch (column) {
		case 'url': {
			return { text: row.url, readOnly: false };
		}
		case 'virtual': {
			return { text: '', readOnly: false, checked: row.virtual };
		}
		case 'inputPath': {
			return { text: row.inputPath ?? '', readOnly: false };
		}
		case 'order': {
			return { text: String(row.order), readOnly: true };
		}
		case 'outputPath': {
			return { text: row.outputPath, readOnly: true };
		}
		case 'parent': {
			return { text: row.parent ?? '', readOnly: true };
		}
		case 'depth': {
			return { text: String(row.depth), readOnly: true };
		}
		default: {
			return null;
		}
	}
}

/**
 * Whether the cell of a fixed column is a box, turned over by Space, Enter and a click without
 * an input opening (as a boolean of the metadata is).
 * @param column - The identifier of the column
 * @example
 * ```ts
 * isFixedBox('virtual'); // true
 * isFixedBox('url'); // false
 * ```
 */
export function isFixedBox(column: string): boolean {
	return column === 'virtual';
}
