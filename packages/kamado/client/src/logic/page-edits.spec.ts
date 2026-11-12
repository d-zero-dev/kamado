import type { Row, Rows } from '../types.js';

import { describe, expect, test } from 'vitest';

import {
	filesOf,
	newPageOf,
	pathEditOf,
	saidOfPage,
	stillToMake,
	urlEditOf,
	virtualEditOf,
	withoutPage,
} from './page-edits.js';

/**
 * A row, as far as these functions read it.
 * @param url - The URL of the page
 * @param inputPath - The path of its file, or `null` for a virtual page
 * @param sidecar - The hash of its sidecar, or `null`
 */
function row(url: string, inputPath: string | null, sidecar: string | null = null): Row {
	return {
		url,
		inputPath,
		outputPath: 'out.html',
		virtual: inputPath === null,
		depth: 1,
		parent: '/',
		hashes: { input: inputPath === null ? null : 'h', sidecar },
		meta: {},
	};
}

describe('what is typed into the inputPath of a page', () => {
	test('another path moves the file, and the same path does nothing', () => {
		expect(pathEditOf(row('/a/', 'a/index.html'), 'b/index.html')).toEqual({
			kind: 'move',
			change: { op: 'movePath', path: 'b/index.html' },
		});
		expect(pathEditOf(row('/a/', 'a/index.html'), 'a/index.html')).toEqual({
			kind: 'none',
		});
	});

	test('an empty path takes the file away, which is asked about first', () => {
		expect(pathEditOf(row('/a/', 'a/index.html'), '')).toEqual({ kind: 'ask' });
		// blanks are not a path
		expect(pathEditOf(row('/a/', 'a/index.html'), '  \t')).toEqual({ kind: 'ask' });
	});

	test('a path typed for a virtual page gives it a file', () => {
		expect(pathEditOf(row('/v/', null), 'v/index.html')).toEqual({
			kind: 'materialize',
			change: { op: 'materialize', path: 'v/index.html' },
		});
	});

	test('a virtual page that is left without a path stays as it is', () => {
		expect(pathEditOf(row('/v/', null), '')).toEqual({ kind: 'none' });
		expect(pathEditOf(row('/v/', null), ' ')).toEqual({ kind: 'none' });
	});
});

describe('what is typed into the url of a page', () => {
	test('another URL moves the page, and the same URL does nothing', () => {
		expect(urlEditOf(row('/a/', 'a/index.html'), '/b/')).toEqual({
			kind: 'move',
			change: { op: 'moveUrl', url: '/b/' },
		});
		expect(urlEditOf(row('/a/', 'a/index.html'), '/a/')).toEqual({ kind: 'none' });
	});

	test('an empty URL takes the page away, which is asked about first', () => {
		expect(urlEditOf(row('/a/', 'a/index.html'), '')).toEqual({ kind: 'ask' });
		expect(urlEditOf(row('/v/', null), '   ')).toEqual({ kind: 'ask' });
	});
});

describe('the box of the virtual column', () => {
	test('a page with a file is made virtual, which is asked about first', () => {
		expect(virtualEditOf(row('/a/', 'a/index.html'))).toEqual({ kind: 'ask' });
	});

	test('a virtual page gets the file its URL names', () => {
		expect(virtualEditOf(row('/v/', null))).toEqual({
			kind: 'materialize',
			change: { op: 'materialize', path: null },
		});
	});
});

describe('a change of whether a page has a file, when its turn comes', () => {
	test('is still to make while the page is what it was when it was asked', () => {
		expect(stillToMake(row('/v/', null), { op: 'materialize', path: null })).toBe(true);
		expect(stillToMake(row('/a/', 'a/index.html'), { op: 'virtualize' })).toBe(true);
	});

	test('is not, once an edit before it has made the page so', () => {
		expect(
			stillToMake(row('/v/', 'v/index.html'), { op: 'materialize', path: null }),
		).toBe(false);
		expect(
			stillToMake(row('/v/', 'v/index.html'), { op: 'materialize', path: 'x.html' }),
		).toBe(false);
		expect(stillToMake(row('/a/', null), { op: 'virtualize' })).toBe(false);
	});

	test('every other change is made whatever the page is', () => {
		expect(stillToMake(row('/v/', null), { op: 'set', key: 'title', value: 'T' })).toBe(
			true,
		);
		expect(stillToMake(row('/a/', 'a.html'), { op: 'movePath', path: 'b.html' })).toBe(
			true,
		);
	});
});

describe('the form that adds a page', () => {
	test('a path makes a page file, with the URL when one is written', () => {
		expect(newPageOf('', 'about/index.html')).toEqual({
			ok: true,
			url: null,
			path: 'about/index.html',
		});
		expect(newPageOf(' /about/ ', ' about/index.html ')).toEqual({
			ok: true,
			url: '/about/',
			path: 'about/index.html',
		});
	});

	test('a URL without a path is a virtual page', () => {
		expect(newPageOf('/service/', '')).toEqual({
			ok: true,
			url: '/service/',
			path: null,
		});
		expect(newPageOf('/service/', '  ')).toEqual({
			ok: true,
			url: '/service/',
			path: null,
		});
	});

	test('nothing is nothing to add', () => {
		expect(newPageOf('', '')).toEqual({ ok: false });
		expect(newPageOf(' ', '\t')).toEqual({ ok: false });
	});
});

describe('the files that go with a page', () => {
	test('the page file, and its sidecar when it has one', () => {
		expect(filesOf(row('/a/', 'a/index.html'))).toEqual(['a/index.html']);
		expect(filesOf(row('/a/', 'a/index.html', 's'))).toEqual([
			'a/index.html',
			'a/index.json',
		]);
		expect(filesOf(row('/n/', 'news/2026.01.tsx', 's'))).toEqual([
			'news/2026.01.tsx',
			'news/2026.01.json',
		]);
	});

	test.each([
		['a.html', 'a.json'],
		['a.htm', 'a.json'],
		['dir.v2/a.tsx', 'dir.v2/a.json'],
		['a.b.jsx', 'a.b.json'],
	])('the sidecar of %s is %s, as the core names it', (inputPath, sidecar) => {
		expect(filesOf(row('/a/', inputPath, 's'))).toEqual([inputPath, sidecar]);
	});

	test('a virtual page has none', () => {
		expect(filesOf(row('/v/', null))).toEqual([]);
	});
});

describe('what is said of a page once the list was read again', () => {
	test('what was done, when the page is among the rows shown', () => {
		expect(saidOfPage(['/a/', '/b/'], '/b/', 'Page /b/ added')).toBe('Page /b/ added');
	});

	test('and that it is not shown here, when it is not', () => {
		expect(saidOfPage(['/a/'], '/z/', 'Page /z/ added')).toBe(
			'Page /z/ added (not on this page)',
		);
		expect(saidOfPage([], '/z/', 'done')).toBe('done (not on this page)');
	});
});

describe('the list after a page was removed', () => {
	const rows: Rows = {
		version: 3,
		offset: 0,
		total: 12,
		columns: ['title'],
		overridesHash: 'o1',
		pages: [row('/a/', 'a/index.html'), row('/b/', 'b/index.html')],
		warnings: [],
	};

	test('the page is gone, and the version and the hash are those of the answer', () => {
		const after = withoutPage(rows, '/a/', { version: 4, overridesHash: 'o2' });
		expect(after.pages.map((page) => page.url)).toEqual(['/b/']);
		expect(after.total).toBe(11);
		expect(after.version).toBe(4);
		expect(after.overridesHash).toBe('o2');
		expect(after.columns).toEqual(['title']);
	});

	test('a page that is not in the window leaves the rows, and still counts one less', () => {
		const after = withoutPage(rows, '/z/', { version: 4, overridesHash: null });
		expect(after.pages).toEqual(rows.pages);
		expect(after.total).toBe(11);
		expect(after.overridesHash).toBeNull();
	});
});
