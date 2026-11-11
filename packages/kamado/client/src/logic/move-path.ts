import type { Change, Row } from '../types.js';

/**
 * The edit that a typed `inputPath` makes: moving the page file to that path. `inputPath` is told
 * from `dir.input` (the server makes it relative, and the core reads a typed path from there), so
 * the text of the cell is what is sent. Nothing for a page that has no file (a virtual page), and
 * nothing when the path is the one the page has.
 * @param row - The page the cell is of
 * @param draft - What was typed
 * @example
 * ```ts
 * pathChangeOf({ inputPath: 'a/index.html' }, 'b/index.html'); // { op: 'movePath', path: 'b/index.html' }
 * pathChangeOf({ inputPath: 'a/index.html' }, 'a/index.html'); // null
 * pathChangeOf({ inputPath: null }, 'a/'); // null
 * ```
 */
export function pathChangeOf(
	row: Pick<Row, 'inputPath'>,
	draft: string,
): Extract<Change, { op: 'movePath' }> | null {
	if (row.inputPath === null || draft === row.inputPath) {
		return null;
	}
	return { op: 'movePath', path: draft };
}
