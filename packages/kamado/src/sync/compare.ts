/**
 * What `select` and `read` of a sync script make of the difference (RFC §14.2, "同期"): the range
 * of the site the outside data corresponds to, and the pages the outside data has.
 *
 * Both ways of a sync are one rule: the difference is found between the range (`select`) and
 * what the outside has (`read`), and the side that is not the source is changed to match.
 * - An import changes the site to what `read` returned, inside the range. A page or a key that
 *   `select` leaves out is not touched, so a script does not have to match the pages itself to
 *   protect what the outside data has no column for. {@link importRows} turns the two lists into
 *   the one list of rows `diff` takes, so that the difference, the edits and their checks are
 *   those of `diff`.
 * - An export shows what the outside would change to match the range. What `select` leaves out is
 *   not touched here either: a key it does not name is not compared, so it is never told as
 *   removed from the outside. {@link exportChanges} finds it: the edits of the site are not made, and none of what the editor needs to refuse
 *   (locked keys, files that git cannot bring back) is asked, because the site is not written.
 *
 * Why the same rows are found in the same way (the same `inputPath`, else the same `url`): a
 * second sync with nothing changed in between must find nothing, whichever way it goes.
 */
import type { Problem, Snapshot } from './diff.js';
import type { SyncChange, SyncChangeKind, SyncSummary } from './types.js';

import { matchPages, pairByPlace, readRows, relativeTo, sameJson } from './diff.js';

/** What {@link importRows} gives. */
export type ImportRows =
	| { readonly ok: true; readonly rows: readonly unknown[] }
	| { readonly ok: false; readonly problems: readonly Problem[] };

/**
 * Every page of the site as rows, the range `select` has when it is left out: all pages, with
 * `virtual` and all of `meta`.
 * @param snapshot - The pages the site has
 * @example
 * ```ts
 * const rows = allPages(snapshot); // [{ url: '/', inputPath: 'index.html', virtual: false, meta: {} }, ...]
 * ```
 */
export function allPages(snapshot: Snapshot): Record<string, unknown>[] {
	return snapshot.pages.map((page) => ({
		url: page.url,
		inputPath:
			page.virtual || page.inputPath === null
				? null
				: relativeTo(snapshot.inputDir, page.inputPath),
		virtual: page.virtual,
		meta: page.meta,
	}));
}

/**
 * Makes the rows of an import: what `read` returned, with the part of the site `select` left
 * out kept as it is.
 *
 * A page `select` returned is in the range: it is removed when `read` does not have it, and its
 * `virtual` and keys are set to what `read` says. What `select` does not name is out of the range:
 * a `virtual` it does not name is kept whatever `read` says, and a key it does not name is kept
 * unless `read` gives that key, which is then compared with what the page has. A page `select` did not return
 * is out of the range: `read` must not give it (it would write outside the range, so it is a
 * problem), and it stays.
 * @param snapshot - The pages the site has
 * @param selectRaw - What `select` returned, or `null` when the script has none (the whole site)
 * @param readRaw - What `read` returned
 * @returns The rows for `diff`, or every problem of `select` and `read`
 * @example
 * ```ts
 * const made = importRows(snapshot, [{ url: '/', meta: { title: '' } }], [{ url: '/', meta: { title: 'Home' } }]);
 * // made.rows: [{ url: '/', meta: { title: 'Home', ...every other key the page has } }, ...the other pages as they are]
 * ```
 */
export function importRows(
	snapshot: Snapshot,
	selectRaw: readonly unknown[] | null,
	readRaw: readonly unknown[],
): ImportRows {
	if (selectRaw === null) {
		return { ok: true, rows: readRaw };
	}
	const { inputDir } = snapshot;
	const selected = readRows(selectRaw, inputDir, 'select row');
	const read = readRows(readRaw, inputDir, 'row');
	const problems: Problem[] = [...selected.problems, ...read.problems];
	if (problems.length > 0) {
		return { ok: false, problems };
	}

	const inSelect = matchPages(snapshot, selected.read).matched;
	for (const row of selected.read) {
		if (!inSelect.has(row)) {
			problems.push({
				row: row.index,
				url: row.url,
				message: `select row ${row.index} (${row.url}): is not a page of the site`,
			});
		}
	}
	const bySelectedPage = new Map(
		[...inSelect].map(([row, page]) => [page, row] as const),
	);
	const asPage = matchPages(snapshot, read.read).matched;
	for (const row of read.read) {
		const page = asPage.get(row);
		if (page !== undefined && !bySelectedPage.has(page)) {
			problems.push({
				row: row.index,
				url: row.url,
				message: `row ${row.index} (${row.url}): the page is outside what select returned, so it cannot be given`,
			});
		}
	}
	if (problems.length > 0) {
		return { ok: false, problems };
	}

	const rows: Record<string, unknown>[] = read.read.map((row) => {
		const made: Record<string, unknown> = { url: row.url };
		const page = asPage.get(row);
		const range = page === undefined ? undefined : bySelectedPage.get(page);
		// Where the file is belongs to the range only when `select` names it: a row that `read`
		// gives for a page whose place `select` does not name does not move the file.
		if (
			row.inputPath !== undefined &&
			(range === undefined || range.inputPath !== undefined)
		) {
			made.inputPath = row.inputPath;
		}
		if (page === undefined || range === undefined) {
			// A page that is made: everything `read` says is what it has.
			if (row.virtual !== undefined) {
				made.virtual = row.virtual;
			}
			if (row.meta !== undefined) {
				made.meta = Object.fromEntries(row.meta);
			}
			return made;
		}
		if (range.virtual !== undefined && row.virtual !== undefined) {
			made.virtual = row.virtual;
		}
		if (range.meta !== undefined && row.meta !== undefined) {
			const merged = new Map(row.meta);
			for (const [key, value] of Object.entries(page.meta)) {
				if (!range.meta.has(key) && !merged.has(key)) {
					merged.set(key, value);
				}
			}
			made.meta = Object.fromEntries(merged);
		}
		return made;
	});
	// A page out of the range is given as it is, so that the rows say it stays.
	for (const page of snapshot.pages) {
		if (bySelectedPage.has(page)) {
			continue;
		}
		const keep: Record<string, unknown> = { url: page.url };
		if (!page.virtual && page.inputPath !== null) {
			keep.inputPath = relativeTo(inputDir, page.inputPath);
		}
		rows.push(keep);
	}
	return { ok: true, rows };
}

/** What {@link exportChanges} gives. */
export type ExportChanges =
	| {
			readonly ok: true;
			readonly summary: Pick<SyncSummary, 'counts' | 'changes'>;
	  }
	| { readonly ok: false; readonly problems: readonly Problem[] };

/**
 * Finds what the outside data would change to be what `select` gave: the difference an export
 * shows. The outside is the data `read` returned, and the range is what `select` returned
 * (every page when the script has none). Only what both say is compared, a field one row leaves
 * out is not (the same as in an import). `select` decides the range of the keys: a key of the
 * outside that `select` does not name is out of the range, so it is neither compared nor told
 * (it is not told as removed). A row of the outside that is a page of the site and not
 * in the range is left alone, and a row that is no page of the site is what the outside has and
 * the site does not: it is told as deleted.
 * @param snapshot - The pages the site has
 * @param selectRaw - What `select` returned, or `null` when the script has none (the whole site)
 * @param readRaw - What `read` returned
 * @returns The summary, or every problem of `select` and `read`
 * @example
 * ```ts
 * const found = exportChanges(snapshot, null, [{ url: '/', meta: { title: 'Old' } }]);
 * if (found.ok) {
 * 	console.log(found.summary.counts);
 * }
 * ```
 */
export function exportChanges(
	snapshot: Snapshot,
	selectRaw: readonly unknown[] | null,
	readRaw: readonly unknown[],
): ExportChanges {
	const { inputDir, outputPathField } = snapshot;
	const range = readRows(selectRaw ?? allPages(snapshot), inputDir, 'select row');
	const outside = readRows(readRaw, inputDir, 'row');
	const problems = [...range.problems, ...outside.problems];
	if (problems.length > 0) {
		return { ok: false, problems };
	}
	const inRange = matchPages(snapshot, range.read).matched;
	for (const row of range.read) {
		if (!inRange.has(row)) {
			problems.push({
				row: row.index,
				url: row.url,
				message: `select row ${row.index} (${row.url}): is not a page of the site`,
			});
		}
	}
	if (problems.length > 0) {
		return { ok: false, problems };
	}
	// A row of the outside that is a page of the site outside the range is none of this export's
	// business: the outside may hold more than the range (a sheet of every page, a range of a few).
	const rangePages = new Set(inRange.values());
	const outsidePages = matchPages(snapshot, outside.read).matched;

	// Which row of the outside each row of the range is.
	const pair = pairByPlace(range.read, outside.read);
	const taken = new Set(pair.values());

	const found: Record<SyncChangeKind, SyncChange[]> = {
		added: [],
		deleted: [],
		movedUrl: [],
		movedFile: [],
		virtualized: [],
		materialized: [],
		meta: [],
	};
	for (const row of range.read) {
		const now = pair.get(row);
		if (now === undefined) {
			const virtual = row.virtual === true;
			found.added.push({
				kind: 'added',
				url: row.url,
				virtual,
				inputPath: virtual || typeof row.inputPath !== 'string' ? null : row.inputPath,
				keys: [...(row.meta?.keys() ?? [])].filter((key) => key !== outputPathField)
					.length,
			});
			continue;
		}
		if (now.url !== row.url) {
			found.movedUrl.push({ kind: 'movedUrl', from: now.url, to: row.url });
		}
		if (
			typeof row.inputPath === 'string' &&
			row.virtual !== true &&
			// An outside with no file (a virtual page) is not a file that moved: it is given one, and
			// that is told as "given a file" below.
			typeof now.inputPath === 'string' &&
			now.inputPath !== row.inputPath
		) {
			found.movedFile.push({
				kind: 'movedFile',
				url: row.url,
				from: now.inputPath,
				to: row.inputPath,
			});
		}
		if (
			row.virtual !== undefined &&
			now.virtual !== undefined &&
			row.virtual !== now.virtual
		) {
			if (row.virtual) {
				found.virtualized.push({
					kind: 'virtualized',
					url: row.url,
					inputPath: now.inputPath ?? '',
				});
			} else {
				found.materialized.push({
					kind: 'materialized',
					url: row.url,
					inputPath: typeof row.inputPath === 'string' ? row.inputPath : null,
				});
			}
		}
		if (row.meta !== undefined && now.meta !== undefined) {
			for (const [key, after] of row.meta) {
				if (key === outputPathField) {
					continue;
				}
				const had = now.meta.has(key);
				if (had && sameJson(now.meta.get(key), after)) {
					continue;
				}
				found.meta.push({
					kind: 'meta',
					url: row.url,
					key,
					...(had ? { before: now.meta.get(key) } : {}),
					after,
				});
			}
		}
	}
	for (const row of outside.read) {
		const page = outsidePages.get(row);
		if (!taken.has(row) && (page === undefined || rangePages.has(page))) {
			found.deleted.push({
				kind: 'deleted',
				url: row.url,
				inputPath: typeof row.inputPath === 'string' ? row.inputPath : null,
			});
		}
	}

	const order: readonly SyncChangeKind[] = [
		'deleted',
		'movedUrl',
		'movedFile',
		'virtualized',
		'materialized',
		'added',
		'meta',
	];
	return {
		ok: true,
		summary: {
			counts: {
				added: found.added.length,
				deleted: found.deleted.length,
				movedUrl: found.movedUrl.length,
				movedFile: found.movedFile.length,
				virtualized: found.virtualized.length,
				materialized: found.materialized.length,
				meta: found.meta.length,
			},
			changes: order.flatMap((kind) => found[kind]),
		},
	};
}
