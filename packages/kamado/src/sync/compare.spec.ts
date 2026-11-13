import type { Problem, Snapshot, SnapshotPage } from './diff.js';

import { describe, expect, test } from 'vitest';

import { allPages, exportChanges, importRows } from './compare.js';
import { diff } from './diff.js';

/**
 * A page of the site.
 * @param url - Its URL
 * @param meta - Its metadata
 * @param virtual - Whether it has no file
 */
function page(
	url: string,
	meta: Record<string, unknown> = {},
	virtual = false,
): SnapshotPage {
	const stem = url.replaceAll('/', '') || 'index';
	return {
		url,
		inputPath: virtual ? null : `/site/src/${stem}/index.html`,
		outputPath: `/site/out/${stem}/index.html`,
		fileSlug: stem,
		filePathStem: `/${stem}/index`,
		extension: '.html',
		depth: 1,
		parent: '/',
		virtual,
		meta,
		hashes: { input: virtual ? null : `h-${stem}`, sidecar: null },
		locked: {},
	};
}

const SNAPSHOT: Snapshot = {
	version: 1,
	overridesHash: null,
	inputDir: '/site/src',
	outputPathField: null,
	warnings: [],
	pages: [
		page('/a/', { title: 'A', layout: 'wide' }),
		page('/b/', { title: 'B', layout: 'narrow' }),
		page('/v/', { title: 'V' }, true),
	],
};

/**
 * The messages of the problems of a result that has some.
 * @param result - What `importRows` or `exportChanges` gave
 */
function messagesOf(
	result:
		| { readonly ok: true }
		| { readonly ok: false; readonly problems: readonly Problem[] },
): string[] {
	if (result.ok) {
		throw new Error('expected problems, but the result is ok');
	}
	return result.problems.map((p) => p.message);
}

describe('allPages', () => {
	test('is every page with its place, whether it is virtual, and all of its metadata', () => {
		expect(allPages(SNAPSHOT)).toEqual([
			{
				url: '/a/',
				inputPath: 'a/index.html',
				virtual: false,
				meta: { title: 'A', layout: 'wide' },
			},
			{
				url: '/b/',
				inputPath: 'b/index.html',
				virtual: false,
				meta: { title: 'B', layout: 'narrow' },
			},
			{ url: '/v/', inputPath: null, virtual: true, meta: { title: 'V' } },
		]);
	});
});

describe('importRows without select', () => {
	test('gives the rows of read as they are: the whole site is the range', () => {
		const read = [{ url: '/a/', meta: { title: 'X' } }];
		expect(importRows(SNAPSHOT, null, read)).toEqual({ ok: true, rows: read });
	});
});

/**
 * The difference an import with these `select` and `read` makes to the site.
 * @param select - What `select` returned
 * @param read - What `read` returned
 */
function importDiff(select: unknown[], read: unknown[]) {
	const made = importRows(SNAPSHOT, select, read);
	if (!made.ok) {
		throw new Error(made.problems.map((p) => p.message).join('\n'));
	}
	const found = diff(SNAPSHOT, made.rows);
	if (!found.ok) {
		throw new Error(found.problems.map((p) => p.message).join('\n'));
	}
	return found;
}

describe('importRows with select', () => {
	test('changes only the keys select names, and keeps the others of the page', () => {
		const found = importDiff(
			[{ url: '/a/', meta: { title: '' } }],
			[{ url: '/a/', meta: { title: 'New' } }],
		);
		expect(found.summary.changes).toEqual([
			{ kind: 'meta', url: '/a/', key: 'title', before: 'A', after: 'New' },
		]);
	});

	test('keeps a page that select did not return, and removes one of the range that read did not return', () => {
		const found = importDiff(
			[
				{ url: '/a/', meta: { title: '' } },
				{ url: '/b/', meta: { title: '' } },
			],
			[{ url: '/a/', meta: { title: 'A' } }],
		);
		expect(found.summary.counts).toMatchObject({ deleted: 1, added: 0, meta: 0 });
		expect(found.summary.changes).toEqual([
			{ kind: 'deleted', url: '/b/', inputPath: 'b/index.html' },
		]);
	});

	test('leaves a page out of the range alone, a virtual one too', () => {
		const found = importDiff([{ url: '/a/', meta: { title: '' } }], []);
		expect(found.summary.changes).toEqual([
			{ kind: 'deleted', url: '/a/', inputPath: 'a/index.html' },
		]);
	});

	test('does not touch the metadata of a page whose select row has none', () => {
		const found = importDiff(
			[{ url: '/a/' }],
			[{ url: '/a/', meta: { title: 'Other' } }],
		);
		expect(found.summary.counts.meta).toBe(0);
	});

	test('compares a key that only read has with what the page has, and sets it when it differs', () => {
		const same = importDiff(
			[{ url: '/a/', meta: { title: '' } }],
			[{ url: '/a/', meta: { title: 'A', layout: 'wide' } }],
		);
		expect(same.summary.counts.meta).toBe(0);
		const differs = importDiff(
			[{ url: '/a/', meta: { title: '' } }],
			[{ url: '/a/', meta: { title: 'A', layout: 'narrow' } }],
		);
		expect(differs.summary.changes).toEqual([
			{ kind: 'meta', url: '/a/', key: 'layout', before: 'wide', after: 'narrow' },
		]);
	});

	test('removes a key select names and read does not give', () => {
		const found = importDiff(
			[{ url: '/a/', meta: { title: '', layout: '' } }],
			[{ url: '/a/', meta: { title: 'A' } }],
		);
		expect(found.summary.changes).toEqual([
			{ kind: 'meta', url: '/a/', key: 'layout', before: 'wide' },
		]);
	});

	test('makes the page that read gives and the site does not have', () => {
		const found = importDiff(
			[{ url: '/a/' }],
			[{ url: '/a/' }, { url: '/n/', virtual: true, meta: { title: 'N' } }],
		);
		expect(found.summary.changes).toEqual([
			{ kind: 'added', url: '/n/', virtual: true, inputPath: null, keys: 1 },
		]);
	});

	test('finds nothing when read gives what select returned (the second run after an import)', () => {
		const select = [{ url: '/a/', meta: { title: '' } }];
		const found = importDiff(select, [{ url: '/a/', meta: { title: 'A' } }]);
		expect(found.edits).toEqual([]);
	});

	test('does not move a file that select does not name, whatever read says of it', () => {
		const found = importDiff(
			[{ url: '/a/', meta: { title: '' } }],
			[{ url: '/a/', inputPath: 'other/index.html', meta: { title: 'A' } }],
		);
		expect(found.summary.counts.movedFile).toBe(0);
		expect(found.edits).toEqual([]);
	});

	test('sets virtual when select names it and read changes it', () => {
		const virtualized = importDiff(
			[{ url: '/a/', virtual: false, inputPath: 'a/index.html' }],
			[{ url: '/a/', virtual: true, inputPath: null }],
		);
		expect(virtualized.summary.changes).toEqual([
			{ kind: 'virtualized', url: '/a/', inputPath: 'a/index.html' },
		]);
		const materialized = importDiff(
			[{ url: '/v/', virtual: true, inputPath: null }],
			[{ url: '/v/', virtual: false, inputPath: 'v/index.html' }],
		);
		expect(materialized.summary.changes).toEqual([
			{ kind: 'materialized', url: '/v/', inputPath: 'v/index.html' },
		]);
	});

	test('ignores the virtual that read gives for a page whose virtual select does not name', () => {
		const found = importDiff(
			[{ url: '/a/', meta: { title: '' } }],
			[{ url: '/a/', virtual: true, meta: { title: 'A' } }],
		);
		expect(found.summary.counts.virtualized).toBe(0);
		expect(found.edits).toEqual([]);
	});

	test('finds a page by the inputPath select names, so that another URL of read is a move', () => {
		const found = importDiff(
			[{ url: '/a/', inputPath: 'a/index.html' }],
			[{ url: '/moved/', inputPath: 'a/index.html' }],
		);
		expect(found.summary.changes).toEqual([
			{ kind: 'movedUrl', from: '/a/', to: '/moved/' },
		]);
	});

	test('says a read row of a page out of the range is a problem', () => {
		const made = importRows(
			SNAPSHOT,
			[{ url: '/a/' }],
			[{ url: '/a/' }, { url: '/b/', meta: { title: 'X' } }],
		);
		expect(made).toEqual({
			ok: false,
			problems: [
				{
					row: 2,
					url: '/b/',
					message:
						'row 2 (/b/): the page is outside what select returned, so it cannot be given',
				},
			],
		});
	});

	test('says a select row that is not a page of the site is a problem', () => {
		const made = importRows(SNAPSHOT, [{ url: '/nope/' }], []);
		expect(made).toEqual({
			ok: false,
			problems: [
				{
					row: 1,
					url: '/nope/',
					message: 'select row 1 (/nope/): is not a page of the site',
				},
			],
		});
	});

	test('tells the problems of select rows and read rows by the name of each', () => {
		const made = importRows(SNAPSHOT, [{ url: 'a' }], [{ url: 'b' }]);
		expect(made.ok).toBe(false);
		expect(messagesOf(made)).toEqual([
			'select row 1 (a): url must be a string that starts with /',
			'row 1 (b): url must be a string that starts with /',
		]);
	});
});

describe('exportChanges', () => {
	test('finds nothing when the outside is what select returned (every page, every key)', () => {
		const found = exportChanges(SNAPSHOT, null, allPages(SNAPSHOT));
		expect(found).toEqual({
			ok: true,
			summary: {
				counts: {
					added: 0,
					deleted: 0,
					movedUrl: 0,
					movedFile: 0,
					virtualized: 0,
					materialized: 0,
					meta: 0,
				},
				changes: [],
			},
		});
	});

	test('adds what the outside lacks and deletes what it has and the site does not', () => {
		const found = exportChanges(
			SNAPSHOT,
			[
				{ url: '/a/', inputPath: 'a/index.html' },
				{ url: '/b/', inputPath: 'b/index.html' },
			],
			[
				{ url: '/a/', inputPath: 'a/index.html' },
				{ url: '/old/', inputPath: 'old/index.html' },
			],
		);
		expect(found.ok && found.summary.changes).toEqual([
			{ kind: 'deleted', url: '/old/', inputPath: 'old/index.html' },
			{ kind: 'added', url: '/b/', virtual: false, inputPath: 'b/index.html', keys: 0 },
		]);
	});

	test('leaves a page of the site outside the range alone, and tells a row that is no page of the site as deleted', () => {
		const found = exportChanges(
			SNAPSHOT,
			[{ url: '/a/', inputPath: 'a/index.html', meta: { title: 'A' } }],
			[
				{ url: '/a/', inputPath: 'a/index.html', meta: { title: 'A' } },
				{ url: '/b/', inputPath: 'b/index.html', meta: { title: 'B' } },
				{ url: '/old/', inputPath: 'old/index.html' },
			],
		);
		expect(found.ok && found.summary.changes).toEqual([
			{ kind: 'deleted', url: '/old/', inputPath: 'old/index.html' },
		]);
	});

	test('says a select row that is not a page of the site is a problem', () => {
		const found = exportChanges(SNAPSHOT, [{ url: '/nope/' }], []);
		expect(found).toEqual({
			ok: false,
			problems: [
				{
					row: 1,
					url: '/nope/',
					message: 'select row 1 (/nope/): is not a page of the site',
				},
			],
		});
	});

	test('tells the keys that differ: changed and new for the outside, and leaves a key only the outside has', () => {
		const found = exportChanges(
			SNAPSHOT,
			[{ url: '/a/', meta: { title: 'A', layout: 'wide' } }],
			[{ url: '/a/', meta: { title: 'Old', note: 'by hand' } }],
		);
		expect(found.ok && found.summary.changes).toEqual([
			{ kind: 'meta', url: '/a/', key: 'title', before: 'Old', after: 'A' },
			{ kind: 'meta', url: '/a/', key: 'layout', after: 'wide' },
		]);
	});

	test('does not compare what a row of either side leaves out', () => {
		const found = exportChanges(
			SNAPSHOT,
			[{ url: '/a/', virtual: false }],
			[{ url: '/a/', meta: { title: 'Old' } }],
		);
		expect(found.ok && found.summary.changes).toEqual([]);
	});

	test('finds a page by its inputPath, so that a changed URL is a move and not a delete and an add', () => {
		const found = exportChanges(
			SNAPSHOT,
			[{ url: '/a/', inputPath: 'a/index.html' }],
			[{ url: '/old-a/', inputPath: 'a/index.html' }],
		);
		expect(found.ok && found.summary.changes).toEqual([
			{ kind: 'movedUrl', from: '/old-a/', to: '/a/' },
		]);
	});

	test('tells that a file moved, and that a page became virtual or was given a file', () => {
		const moved = exportChanges(
			SNAPSHOT,
			[{ url: '/a/', inputPath: 'a/index.html' }],
			[{ url: '/a/', inputPath: 'old/index.html' }],
		);
		expect(moved.ok && moved.summary.changes).toEqual([
			{ kind: 'movedFile', url: '/a/', from: 'old/index.html', to: 'a/index.html' },
		]);
		const virtualized = exportChanges(
			SNAPSHOT,
			[{ url: '/a/', virtual: true, inputPath: null }],
			[{ url: '/a/', virtual: false, inputPath: 'a/index.html' }],
		);
		expect(virtualized.ok && virtualized.summary.changes).toEqual([
			{ kind: 'virtualized', url: '/a/', inputPath: 'a/index.html' },
		]);
		const materialized = exportChanges(
			SNAPSHOT,
			[{ url: '/v/', virtual: false, inputPath: 'v/index.html' }],
			[{ url: '/v/', virtual: true, inputPath: null }],
		);
		expect(materialized.ok && materialized.summary.changes).toEqual([
			{ kind: 'materialized', url: '/v/', inputPath: 'v/index.html' },
		]);
	});

	test('tells every problem of both lists, by the name of each', () => {
		const found = exportChanges(
			SNAPSHOT,
			[{ url: '/a/' }, { url: '/a/' }],
			[{ url: 'b' }],
		);
		expect(found.ok).toBe(false);
		expect(messagesOf(found)).toEqual([
			'select row 2 (/a/): the url is already the url of row 1',
			'row 1 (b): url must be a string that starts with /',
		]);
	});

	test('does not count the key that decides the URL in the keys of an added page', () => {
		const withField: Snapshot = { ...SNAPSHOT, outputPathField: 'slug' };
		const found = exportChanges(
			withField,
			[{ url: '/b/', inputPath: 'b/index.html', meta: { slug: 'b', title: 'B' } }],
			[],
		);
		expect(found.ok && found.summary.changes).toEqual([
			{ kind: 'added', url: '/b/', virtual: false, inputPath: 'b/index.html', keys: 1 },
		]);
	});

	test('leaves the key that decides the URL out of the comparison', () => {
		const withField: Snapshot = { ...SNAPSHOT, outputPathField: 'slug' };
		const found = exportChanges(
			withField,
			[{ url: '/a/', meta: { slug: 'a', title: 'A' } }],
			[{ url: '/a/', meta: { slug: 'other', title: 'A' } }],
		);
		expect(found.ok && found.summary.changes).toEqual([]);
	});
});
