import { describe, expect, test } from 'vitest';

import { diff, pairByPlace, type Snapshot, type SnapshotPage } from './diff.js';

const INPUT = '/site/src';

/**
 * A page with a file, as the core lists it.
 * @param url
 * @param rel
 * @param meta
 * @param extra
 */
function file(
	url: string,
	rel: string,
	meta: Record<string, unknown> = {},
	extra: Partial<SnapshotPage> = {},
): SnapshotPage {
	return {
		url,
		inputPath: `${INPUT}/${rel}`,
		outputPath: `/site/out${url}`,
		fileSlug: 'x',
		filePathStem: `/${rel.replace(/\.[^.]+$/u, '')}`,
		extension: '.html',
		depth: 1,
		parent: '/',
		virtual: false,
		meta,
		hashes: { input: `hash:${rel}`, sidecar: null },
		locked: {},
		...extra,
	};
}

/**
 * A virtual page, as the core lists it.
 * @param url
 * @param meta
 */
function virtual(url: string, meta: Record<string, unknown> = {}): SnapshotPage {
	return {
		url,
		inputPath: null,
		outputPath: `/site/out${url}`,
		fileSlug: 'x',
		filePathStem: `${url}index`,
		extension: null,
		depth: 1,
		parent: '/',
		virtual: true,
		meta,
		hashes: { input: null, sidecar: null },
		locked: {},
	};
}

/**
 *
 * @param pages
 * @param extra
 */
function snapshot(pages: SnapshotPage[], extra: Partial<Snapshot> = {}): Snapshot {
	return {
		version: 3,
		overridesHash: 'ov',
		inputDir: INPUT,
		outputPathField: null,
		pages,
		warnings: [],
		...extra,
	};
}

/**
 * What a script returns for the pages it was given, unchanged.
 * @param pages
 */
const asReturned = (pages: SnapshotPage[]): unknown[] =>
	pages.map((page) =>
		Object.fromEntries(
			Object.entries(page).filter(([key]) => key !== 'hashes' && key !== 'locked'),
		),
	);

/**
 *
 * @param result
 */
function edits(result: ReturnType<typeof diff>) {
	if (!result.ok) {
		throw new Error(`problems: ${JSON.stringify(result.problems)}`);
	}
	return result.edits;
}

/**
 *
 * @param result
 */
function problems(result: ReturnType<typeof diff>): string[] {
	if (result.ok) {
		throw new Error('no problem was told');
	}
	return result.problems.map((p) => p.message);
}

const A = file('/a/', 'a/index.html', { title: 'A' });
const B = file('/b.html', 'b.html', { title: 'B' });
const V = virtual('/v/', { title: 'V' });
const EXPECT_A = { input: 'hash:a/index.html', sidecar: null, overrides: 'ov' };
const EXPECT_B = { input: 'hash:b.html', sidecar: null, overrides: 'ov' };

describe('what is given is what is kept', () => {
	test('the pages returned as they were given change nothing', () => {
		const current = snapshot([A, B, V]);
		const result = diff(current, asReturned([A, B, V]));
		expect(edits(result)).toEqual([]);
		expect(result.ok && result.summary.counts).toEqual({
			added: 0,
			deleted: 0,
			movedUrl: 0,
			movedFile: 0,
			virtualized: 0,
			materialized: 0,
			meta: 0,
		});
		expect(result.ok && result.summary.changes).toEqual([]);
	});

	test('the order of the pages returned means nothing', () => {
		const current = snapshot([A, B, V]);
		expect(edits(diff(current, asReturned([V, B, A])))).toEqual([]);
	});

	test('only url, inputPath, virtual and meta are read', () => {
		const current = snapshot([A]);
		const row = { ...asReturned([A])[0], depth: 99, parent: '/zzz/', anything: [1, 2] };
		expect(edits(diff(current, [row]))).toEqual([]);
	});

	test('a page given by its url alone stays as it is', () => {
		expect(edits(diff(snapshot([A, V]), [{ url: '/a/' }, { url: '/v/' }]))).toEqual([]);
	});
});

describe('which page a row is (RFC 14.2)', () => {
	test('the same inputPath is the same page, and a different url is a move of the url', () => {
		const result = diff(snapshot([A]), [{ url: '/moved/', inputPath: 'a/index.html' }]);
		expect(edits(result)).toEqual([
			{
				url: '/a/',
				expect: EXPECT_A,
				change: { op: 'moveUrl', url: '/moved/' },
			},
		]);
		expect(result.ok && result.summary.changes).toEqual([
			{ kind: 'movedUrl', from: '/a/', to: '/moved/' },
		]);
	});

	test('the same url with a different inputPath moves the file of a page whose url a key decides', () => {
		const slugged = file(
			'/a/',
			'a.html',
			{ slug: '/a/' },
			{ locked: { slug: 'the url' } },
		);
		const result = diff(snapshot([slugged], { outputPathField: 'slug' }), [
			{ url: '/a/', inputPath: 'elsewhere/a.html' },
		]);
		expect(edits(result)).toEqual([
			{
				url: '/a/',
				expect: { input: 'hash:a.html', sidecar: null, overrides: 'ov' },
				change: { op: 'movePath', path: 'elsewhere/a.html' },
			},
		]);
		expect(result.ok && result.summary.changes).toEqual([
			{ kind: 'movedFile', url: '/a/', from: 'a.html', to: 'elsewhere/a.html' },
		]);
	});

	test('the same url with a different inputPath moves nothing for a page whose url is where its file is', () => {
		// the file of such a page cannot move without the url changing: the inputPath only
		// recognises the page, and a row that still has the inputPath from before a move of the url
		// is not another move
		expect(
			edits(diff(snapshot([A]), [{ url: '/a/', inputPath: 'elsewhere/a.html' }])),
		).toEqual([]);
		expect(
			edits(
				diff(snapshot([A], { outputPathField: 'slug' }), [
					{ url: '/a/', inputPath: 'x/a.html' },
				]),
			),
		).toEqual([]);
	});

	test('what was applied, given again as it was given before, is no change (a move of the url)', () => {
		// the page was at /a/ in a/index.html; the script moved it to /moved/ and kept the inputPath
		const rows = [{ url: '/moved/', inputPath: 'a/index.html' }];
		const first = diff(snapshot([A]), rows);
		expect(edits(first).map((e) => e.change.op)).toEqual(['moveUrl']);
		// now the page is at /moved/ in moved/index.html, and the same rows come back
		const after = file('/moved/', 'moved/index.html', { title: 'A' });
		expect(edits(diff(snapshot([after]), rows))).toEqual([]);
	});

	test('a url that is not the same and no inputPath that is known makes a new page and removes the old', () => {
		const result = diff(snapshot([A]), [{ url: '/z/', virtual: true }]);
		expect(edits(result).map((e) => e.change.op)).toEqual(['create', 'deletePage']);
	});

	test('an inputPath wins over the url: two pages that trade urls are two moves', () => {
		const result = diff(snapshot([A, B]), [
			{ url: '/b.html', inputPath: 'a/index.html' },
			{ url: '/a/', inputPath: 'b.html' },
		]);
		expect(edits(result)).toEqual([
			{
				url: '/a/',
				expect: EXPECT_A,
				change: { op: 'moveUrl', url: '/b.html' },
			},
			{
				url: '/b.html',
				expect: EXPECT_B,
				change: { op: 'moveUrl', url: '/a/' },
			},
		]);
	});

	test('a row that names the file of a page and takes the url of another page does not take that page', () => {
		// the first row is page A by its file, and moves it to '/c/'; the second row has the url
		// A had and a file that does not exist: it is a new page, and A is not taken twice
		const result = diff(snapshot([A]), [
			{ url: '/c/', inputPath: 'a/index.html' },
			{ url: '/a/', inputPath: 'fresh.html', virtual: false },
		]);
		expect(edits(result).map((e) => [e.url, e.change.op])).toEqual([
			['/a/', 'moveUrl'],
			['/a/', 'create'],
		]);
	});

	test('an absolute inputPath inside dir.input is the relative one', () => {
		expect(
			edits(diff(snapshot([A]), [{ url: '/a/', inputPath: `${INPUT}/a/index.html` }])),
		).toEqual([]);
		expect(
			edits(diff(snapshot([A]), [{ url: '/m/', inputPath: `${INPUT}/a/index.html` }])),
		).toHaveLength(1);
	});

	test('a path inside dir.input whose name starts with two dots is inside it', () => {
		expect(
			edits(
				diff(snapshot([A]), [
					{ url: '/d/', inputPath: `${INPUT}/..drafts/d.html`, virtual: false },
				]),
			).map((e) => e.change),
		).toEqual([{ op: 'create', path: '..drafts/d.html' }, { op: 'deletePage' }]);
		expect(
			problems(diff(snapshot([A]), [{ url: '/d/', inputPath: `${INPUT}/../d.html` }])),
		).toEqual(['row 1 (/d/): inputPath is outside dir.input']);
	});

	test('a page that is not returned is removed', () => {
		const result = diff(snapshot([A, B, V]), [{ url: '/a/' }]);
		expect(edits(result)).toEqual([
			{ url: '/b.html', expect: EXPECT_B, change: { op: 'deletePage' } },
			{
				url: '/v/',
				expect: { input: null, sidecar: null, overrides: 'ov' },
				change: { op: 'deletePage' },
			},
		]);
		expect(result.ok && result.summary.changes).toEqual([
			{ kind: 'deleted', url: '/b.html', inputPath: 'b.html' },
			{ kind: 'deleted', url: '/v/', inputPath: null },
		]);
	});

	test('an empty list removes every page', () => {
		expect(edits(diff(snapshot([A, B]), []))).toHaveLength(2);
	});
});

describe('a page that moves off a url that another page is made at', () => {
	test('is told when a key of the moved page would be set, as the same url would name the new page', () => {
		const result = diff(snapshot([A]), [
			{ url: '/q/', inputPath: 'a/index.html', meta: { title: 'X' } },
			{ url: '/a/', virtual: true },
		]);
		expect(problems(result)).toEqual([
			'row 1 (/q/): the page moves away from /a/ and another page is made there, so a key or the file of the moved page cannot be told apart from those of the new one (the same url names both): do it in a sync of its own after the move',
		]);
	});

	test('is made when nothing but the move is asked of the moved page', () => {
		const result = diff(snapshot([A]), [
			{ url: '/q/', inputPath: 'a/index.html' },
			{ url: '/a/', virtual: true, meta: { title: 'New' } },
		]);
		expect(edits(result).map((e) => [e.url, e.change.op])).toEqual([
			['/a/', 'moveUrl'],
			['/a/', 'create'],
			['/a/', 'set'],
		]);
	});
});

describe('a page that is new', () => {
	const NEW = { input: null, sidecar: null, overrides: 'ov' };

	test('a virtual page is made in pages.overrides', () => {
		const result = diff(snapshot([]), [{ url: '/n/', virtual: true }]);
		expect(edits(result)).toEqual([
			{ url: '/n/', expect: NEW, change: { op: 'create', path: null } },
		]);
		expect(result.ok && result.summary.changes).toEqual([
			{ kind: 'added', url: '/n/', virtual: true, inputPath: null, keys: 0 },
		]);
	});

	test('a page with a file is made where inputPath says', () => {
		const result = diff(snapshot([]), [
			{ url: '/n/', inputPath: 'n/index.html', virtual: false, meta: { title: 'N' } },
		]);
		expect(edits(result)).toEqual([
			{ url: '/n/', expect: NEW, change: { op: 'create', path: 'n/index.html' } },
			{
				url: '/n/',
				expect: NEW,
				change: { op: 'set', key: 'title', value: 'N' },
			},
		]);
		expect(result.ok && result.summary.changes).toEqual([
			{ kind: 'added', url: '/n/', virtual: false, inputPath: 'n/index.html', keys: 1 },
		]);
	});

	test('a page with a file and no inputPath is made virtual and then given the file its url says', () => {
		expect(
			edits(diff(snapshot([]), [{ url: '/n/', virtual: false }])).map((e) => e.change),
		).toEqual([
			{ op: 'create', path: null },
			{ op: 'materialize', path: null },
		]);
	});

	test('the keys of a new page are set, but not the key that decides the url', () => {
		const result = diff(snapshot([], { outputPathField: 'slug' }), [
			{ url: '/n/', virtual: true, meta: { title: 'N', slug: '/n/' } },
		]);
		expect(edits(result).map((e) => e.change)).toEqual([
			{ op: 'create', path: null },
			{ op: 'set', key: 'title', value: 'N' },
		]);
	});

	test('virtual must be said', () => {
		expect(problems(diff(snapshot([]), [{ url: '/n/' }]))).toEqual([
			'row 1 (/n/): the page does not exist yet, so virtual must be true or false',
		]);
	});
});

describe('a page that is the same', () => {
	test('virtual to true makes the page virtual', () => {
		const result = diff(snapshot([A]), [{ url: '/a/', virtual: true }]);
		expect(edits(result)).toEqual([
			{ url: '/a/', expect: EXPECT_A, change: { op: 'virtualize' } },
		]);
		expect(result.ok && result.summary.changes).toEqual([
			{ kind: 'virtualized', url: '/a/', inputPath: 'a/index.html' },
		]);
	});

	test('virtual to false gives a virtual page its file', () => {
		const result = diff(snapshot([V]), [{ url: '/v/', virtual: false }]);
		expect(edits(result)).toEqual([
			{
				url: '/v/',
				expect: { input: null, sidecar: null, overrides: 'ov' },
				change: { op: 'materialize', path: null },
			},
		]);
		expect(result.ok && result.summary.changes).toEqual([
			{ kind: 'materialized', url: '/v/', inputPath: null },
		]);
	});

	test('virtual to false with an inputPath gives the file that place', () => {
		const result = diff(snapshot([V]), [
			{ url: '/v/', virtual: false, inputPath: 'v/index.html' },
		]);
		expect(edits(result).map((e) => e.change)).toEqual([
			{ op: 'materialize', path: 'v/index.html' },
		]);
	});

	test('a file that is virtual and not said to be does not get a path by accident', () => {
		expect(
			problems(diff(snapshot([V]), [{ url: '/v/', inputPath: 'v/index.html' }])),
		).toEqual([
			'row 1 (/v/): the page is virtual, so give virtual: false to give it a file',
		]);
	});

	test('virtual left out leaves it', () => {
		expect(edits(diff(snapshot([A, V]), [{ url: '/a/' }, { url: '/v/' }]))).toEqual([]);
	});
});

describe('metadata', () => {
	const PAGE = file('/p/', 'p.html', {
		title: 'P',
		layout: 'x',
		n: 1,
		deep: { a: [1, 2], b: null },
	});
	const EXPECT_P = { input: 'hash:p.html', sidecar: null, overrides: 'ov' };

	test('a value that differs is set, a key that is new is set, a key that is missing is deleted', () => {
		const result = diff(snapshot([PAGE]), [
			{
				url: '/p/',
				meta: { title: 'Q', n: 1, deep: { a: [1, 2], b: null }, added: true },
			},
		]);
		expect(edits(result)).toEqual([
			{ url: '/p/', expect: EXPECT_P, change: { op: 'set', key: 'title', value: 'Q' } },
			{ url: '/p/', expect: EXPECT_P, change: { op: 'set', key: 'added', value: true } },
			{ url: '/p/', expect: EXPECT_P, change: { op: 'delete', key: 'layout' } },
		]);
		expect(result.ok && result.summary.changes).toEqual([
			{ kind: 'meta', url: '/p/', key: 'title', before: 'P', after: 'Q' },
			{ kind: 'meta', url: '/p/', key: 'added', after: true },
			{ kind: 'meta', url: '/p/', key: 'layout', before: 'x' },
		]);
		expect(result.ok && result.summary.counts.meta).toBe(3);
	});

	test('values are compared as JSON: the order of keys does not matter, the order of an array does, and a string is not a number', () => {
		const same = diff(snapshot([PAGE]), [
			{
				url: '/p/',
				meta: { layout: 'x', title: 'P', n: 1, deep: { b: null, a: [1, 2] } },
			},
		]);
		expect(edits(same)).toEqual([]);
		const array = diff(snapshot([PAGE]), [
			{
				url: '/p/',
				meta: { layout: 'x', title: 'P', n: 1, deep: { a: [2, 1], b: null } },
			},
		]);
		expect(edits(array).map((e) => e.change)).toEqual([
			{ op: 'set', key: 'deep', value: { a: [2, 1], b: null } },
		]);
		const text = diff(snapshot([PAGE]), [
			{
				url: '/p/',
				meta: { layout: 'x', title: 'P', n: '1', deep: { a: [1, 2], b: null } },
			},
		]);
		expect(edits(text).map((e) => e.change)).toEqual([
			{ op: 'set', key: 'n', value: '1' },
		]);
	});

	test('null is a value, not a missing key', () => {
		const result = diff(snapshot([PAGE]), [
			{
				url: '/p/',
				meta: { layout: 'x', title: null, n: 1, deep: { a: [1, 2], b: null } },
			},
		]);
		expect(edits(result).map((e) => e.change)).toEqual([
			{ op: 'set', key: 'title', value: null },
		]);
	});

	test('meta left out leaves the metadata, an empty meta removes every key', () => {
		expect(edits(diff(snapshot([PAGE]), [{ url: '/p/' }]))).toEqual([]);
		expect(
			edits(diff(snapshot([PAGE]), [{ url: '/p/', meta: {} }])).map((e) => e.change.op),
		).toEqual(['delete', 'delete', 'delete', 'delete']);
	});

	test('the key that decides the url is not compared, whichever way', () => {
		const page = file('/p/', 'p.html', { title: 'P', slug: '/p/' });
		const field = { outputPathField: 'slug' };
		expect(
			edits(diff(snapshot([page], field), [{ url: '/p/', meta: { title: 'P' } }])),
		).toEqual([]);
		expect(
			edits(
				diff(snapshot([page], field), [
					{ url: '/p/', meta: { title: 'P', slug: '/x/' } },
				]),
			),
		).toEqual([]);
	});

	test('a key named like a property of every object is an ordinary key', () => {
		const row = JSON.parse(
			'{"url":"/p/","meta":{"__proto__":{"polluted":true},"constructor":1,"title":"P","layout":"x","n":1,"deep":{"a":[1,2],"b":null}}}',
		) as unknown;
		const result = diff(snapshot([PAGE]), [row]);
		const changes = edits(result).map((e) => e.change);
		expect(changes).toContainEqual({
			op: 'set',
			key: '__proto__',
			value: JSON.parse('{"polluted":true}'),
		});
		expect(changes).toContainEqual({ op: 'set', key: 'constructor', value: 1 });
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		// what goes to the core keeps the key as a key
		expect(JSON.stringify(changes[0])).toContain('"__proto__"');
	});

	test('a move and a key of the same page name the page as it is now', () => {
		const result = diff(snapshot([PAGE]), [
			{
				url: '/moved/',
				inputPath: 'p.html',
				meta: { title: 'Q', layout: 'x', n: 1, deep: { a: [1, 2], b: null } },
			},
		]);
		expect(edits(result).map((e) => [e.url, e.change.op])).toEqual([
			['/p/', 'moveUrl'],
			['/p/', 'set'],
		]);
	});

	test('the keys of a virtual page are told as a virtual page has them', () => {
		const result = diff(snapshot([V]), [{ url: '/v/', meta: { title: 'W' } }]);
		expect(edits(result)).toEqual([
			{
				url: '/v/',
				expect: { input: null, sidecar: null, overrides: 'ov' },
				change: { op: 'set', key: 'title', value: 'W' },
			},
		]);
	});
});

describe('pages.overrides in the files a sync takes from the place they are in', () => {
	const OVERRIDES = '/site/pages.overrides.json';
	const withFile = (pages: SnapshotPage[]) =>
		snapshot(pages, { overridesFile: OVERRIDES });

	test.each([
		['a virtual page that goes', [A, V], [{ url: '/a/' }], true],
		['a page made virtual', [A], [{ url: '/a/', virtual: true }], true],
		['a virtual page given its file', [V], [{ url: '/v/', virtual: false }], true],
		[
			'a virtual page that is made',
			[A],
			[{ url: '/a/' }, { url: '/n/', virtual: true }],
			true,
		],
		[
			'a page made with no place for its file',
			[A],
			[{ url: '/a/' }, { url: '/n/', virtual: false }],
			true,
		],
		['a key of a virtual page', [V], [{ url: '/v/', meta: { title: 'W' } }], true],
		['a key of a page with a file', [A], [{ url: '/a/', meta: { title: 'Z' } }], false],
		['a page with a file that goes', [A, B], [{ url: '/a/' }], false],
		[
			'a page with a file that is made',
			[A],
			[{ url: '/a/' }, { url: '/n/', virtual: false, inputPath: 'n.html' }],
			false,
		],
	] as const)('%s', (_name, pages, rows, writes) => {
		const result = diff(withFile([...pages]), rows);
		expect(result.ok && result.filesAtRisk.includes(OVERRIDES)).toBe(writes);
	});

	test('is not looked at for a site that has no pages.overrides', () => {
		const result = diff(snapshot([V]), []);
		expect(result.ok && result.filesAtRisk).toEqual([]);
	});
});

describe('the files a sync takes from the place they are in', () => {
	test('the files of what is removed, made virtual or moved are listed', () => {
		const withSidecar = file(
			'/s/',
			's.html',
			{},
			{ hashes: { input: 'h', sidecar: 'hs' } },
		);
		const result = diff(snapshot([A, B, withSidecar]), [
			{ url: '/a/', virtual: true },
			{ url: '/c.html', inputPath: 'b.html' },
		]);
		expect(result.ok && result.filesAtRisk.toSorted()).toEqual([
			`${INPUT}/a/index.html`,
			`${INPUT}/b.html`,
			`${INPUT}/s.html`,
			`${INPUT}/s.json`,
		]);
	});

	test('a key set or a page made takes nothing from its place', () => {
		const result = diff(snapshot([A]), [
			{ url: '/a/', meta: { title: 'Z' } },
			{ url: '/n/', virtual: true },
		]);
		expect(result.ok && result.filesAtRisk).toEqual([]);
	});
});

describe('what cannot be taken is told, all of it, and nothing is made', () => {
	test.each([
		['a list that is not a list of objects', ['x', 1, null, [1]], 4],
		['a url that is missing', [{}], 1],
		['a url that is not a string', [{ url: 3 }], 1],
		['a url that does not start with a slash', [{ url: 'a/' }], 1],
		['an inputPath that is not a string or null', [{ url: '/a/', inputPath: 1 }], 1],
		['an empty inputPath', [{ url: '/a/', inputPath: '' }], 1],
		['an inputPath outside dir.input', [{ url: '/a/', inputPath: '../x.html' }], 1],
		['an absolute inputPath outside dir.input', [{ url: '/a/', inputPath: '/etc/x' }], 1],
		['a virtual that is not a boolean', [{ url: '/a/', virtual: 'yes' }], 1],
		[
			'a virtual page that has an inputPath',
			[{ url: '/n/', virtual: true, inputPath: 'n.html' }],
			1,
		],
		['a meta that is not an object', [{ url: '/a/', meta: [] }], 1],
		['a meta that is null', [{ url: '/a/', meta: null }], 1],
		['the same url twice', [{ url: '/a/' }, { url: '/a/' }], 1],
		[
			'the same inputPath twice',
			[
				{ url: '/a/', inputPath: 'a/index.html' },
				{ url: '/x/', inputPath: 'a/index.html' },
			],
			1,
		],
	])('%s', (_name, rows, count) => {
		const told = diff(snapshot([A]), rows);
		expect(told.ok).toBe(false);
		expect(told.ok ? 0 : told.problems.length).toBeGreaterThanOrEqual(count);
	});

	test('every problem is told at once, with the row and the url', () => {
		const told = problems(
			diff(snapshot([A]), [
				{ url: 'no-slash' },
				{ url: '/n/' },
				{ url: '/a/', virtual: 'x' },
				{ url: '/a/' },
			]),
		);
		expect(told).toEqual([
			'row 1 (no-slash): url must be a string that starts with /',
			'row 3 (/a/): virtual must be true or false',
			'row 4 (/a/): the url is already the url of row 3',
			'row 2 (/n/): the page does not exist yet, so virtual must be true or false',
		]);
	});

	test('a key that cannot be edited is not changed or removed', () => {
		const flow = file(
			'/f/',
			'f.html',
			{ title: 'F', keep: 1 },
			{
				locked: {
					title: 'the front matter is a flow mapping',
					keep: 'the front matter is a flow mapping',
				},
			},
		);
		const set = problems(
			diff(snapshot([flow]), [{ url: '/f/', meta: { title: 'G', keep: 1 } }]),
		);
		expect(set).toEqual([
			'row 1 (/f/): the key title cannot be changed: the front matter is a flow mapping',
		]);
		const del = problems(diff(snapshot([flow]), [{ url: '/f/', meta: { title: 'F' } }]));
		expect(del).toEqual([
			'row 1 (/f/): the key keep cannot be removed: the front matter is a flow mapping',
		]);
		// the same value is not a change, so it is not a problem
		expect(
			edits(diff(snapshot([flow]), [{ url: '/f/', meta: { title: 'F', keep: 1 } }])),
		).toEqual([]);
	});

	test('a problem makes the result a failure, with no edits', () => {
		const told = diff(snapshot([A, B]), [
			{ url: '/a/', meta: { title: 'X' } },
			{ url: 'bad' },
		]);
		expect(told.ok).toBe(false);
		expect('edits' in told).toBe(false);
	});
});

describe('the summary counts and lists what the edits do', () => {
	test('every kind is counted', () => {
		const current = snapshot(
			[
				file('/a/', 'a.html', { t: 1 }),
				file('/b/', 'b.html'),
				file('/c/', 'c.html', { slug: '/c/' }, { locked: { slug: 'the url' } }),
				file('/d/', 'd.html'),
				virtual('/e/'),
				file('/gone/', 'gone.html'),
			],
			{ outputPathField: 'slug' },
		);
		const result = diff(current, [
			{ url: '/a/', meta: { t: 2 } },
			{ url: '/b2/', inputPath: 'b.html' },
			{ url: '/c/', inputPath: 'c2.html' },
			{ url: '/d/', virtual: true },
			{ url: '/e/', virtual: false },
			{ url: '/new/', virtual: true },
		]);
		expect(result.ok && result.summary.counts).toEqual({
			added: 1,
			deleted: 1,
			movedUrl: 1,
			movedFile: 1,
			virtualized: 1,
			materialized: 1,
			meta: 1,
		});
		expect(result.ok && result.summary.changes.map((c) => c.kind)).toEqual([
			'deleted',
			'movedUrl',
			'movedFile',
			'virtualized',
			'materialized',
			'added',
			'meta',
		]);
	});
});

describe('the keys that cannot be edited, when the list does not tell them', () => {
	const bare = (url: string, rel: string, meta: Record<string, unknown> = {}) => {
		return Object.fromEntries(
			Object.entries(file(url, rel, meta)).filter(([key]) => key !== 'locked'),
		) as unknown as SnapshotPage;
	};

	test('a difference that changes no key asks for none', () => {
		const result = diff(snapshot([bare('/a/', 'a/index.html', { title: 'A' })]), [
			{ url: '/a/', meta: { title: 'A' } },
			{ url: '/n/', virtual: true },
		]);
		expect(result.ok && result.needsLocked).toEqual([]);
	});

	test('a key that would be changed or removed asks for the keys of its page, and only of that page', () => {
		const current = snapshot([
			bare('/a/', 'a/index.html', { title: 'A' }),
			bare('/b/', 'b/index.html', { title: 'B' }),
			bare('/c/', 'c/index.html', { title: 'C' }),
		]);
		const result = diff(current, [
			{ url: '/a/', meta: { title: 'changed' } },
			{ url: '/b/', meta: {} },
			{ url: '/c/', meta: { title: 'C' } },
		]);
		expect(result.ok && result.needsLocked.toSorted()).toEqual(['/a/', '/b/']);
	});

	test('a page that is told its locks does not ask again, and a lock is then a problem', () => {
		const told = file(
			'/a/',
			'a/index.html',
			{ title: 'A' },
			{ locked: { title: 'flow mapping' } },
		);
		const result = diff(snapshot([told]), [{ url: '/a/', meta: { title: 'changed' } }]);
		expect(result.needsLocked).toEqual([]);
		expect(problems(result)).toEqual([
			'row 1 (/a/): the key title cannot be changed: flow mapping',
		]);
	});

	test('a file that would be moved asks for the keys of its page, to know whether a key decides its url', () => {
		const result = diff(
			snapshot([bare('/a/', 'a.html', { slug: '/a/' })], { outputPathField: 'slug' }),
			[{ url: '/a/', inputPath: 'elsewhere/a.html' }],
		);
		expect(result.needsLocked).toEqual(['/a/']);
	});

	test('the problems found before the keys are told still say which keys are asked for', () => {
		const result = diff(snapshot([bare('/a/', 'a/index.html', { title: 'A' })]), [
			{ url: '/a/', meta: { title: 'changed' } },
			{ url: 'bad' },
		]);
		expect(result.ok).toBe(false);
		expect(result.needsLocked).toEqual(['/a/']);
	});
});

describe('pairByPlace', () => {
	test('pairs by inputPath first, so that a changed url is the same page', () => {
		const item = { url: '/new/', inputPath: 'a.html' };
		const other = { url: '/old/', inputPath: 'a.html' };
		expect([...pairByPlace([item], [other])]).toEqual([[item, other]]);
	});

	test('pairs by url what has no inputPath to pair by', () => {
		const item = { url: '/a/' };
		const other = { url: '/a/', inputPath: null };
		expect([...pairByPlace([item], [other])]).toEqual([[item, other]]);
	});

	test('does not pair an item with a partner that another item took by inputPath', () => {
		const first = { url: '/x/', inputPath: 'a.html' };
		const second = { url: '/a/' };
		const other = { url: '/a/', inputPath: 'a.html' };
		expect([...pairByPlace([second, first], [other])]).toEqual([[first, other]]);
	});

	test('falls back to the url when the inputPath finds nobody, and leaves an item with no partner out', () => {
		const item = { url: '/a/', inputPath: 'b.html' };
		const other = { url: '/a/', inputPath: 'a.html' };
		const stray = { url: '/z/' };
		expect([...pairByPlace([item, stray], [other])]).toEqual([[item, other]]);
	});
});
