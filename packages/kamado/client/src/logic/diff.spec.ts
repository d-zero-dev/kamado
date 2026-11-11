import type { Diffs, PageDiff } from '../types.js';

import { describe, expect, test } from 'vitest';

import { translator } from '../i18n/translate.js';

import {
	cellDiffOf,
	diffNote,
	originLabel,
	originName,
	revertFailureOf,
	revertKeyOf,
	valueText,
	withPageDiff,
	writeNames,
} from './diff.js';

const OID = 'a'.repeat(40);

const page: PageDiff = {
	url: { kind: 'modified', head: '/old/', revertible: true },
	inputPath: { kind: 'added', revertible: false },
	meta: {
		title: { kind: 'modified', head: 'Old', revertible: true },
		extra: { kind: 'added', revertible: true },
		gone: { kind: 'deleted', head: 'x', revertible: false },
	},
};

describe('cellDiffOf', () => {
	test('is the difference of the column of a page', () => {
		expect(cellDiffOf(page, 'url')).toEqual(page.url);
		expect(cellDiffOf(page, 'inputPath')).toEqual(page.inputPath);
		expect(cellDiffOf(page, 'meta:title')).toEqual(page.meta?.title);
		expect(cellDiffOf(page, 'meta:gone')?.kind).toBe('deleted');
	});

	test('is nothing for a column that does not differ, and for the virtual column', () => {
		expect(cellDiffOf(page, 'meta:nav')).toBeUndefined();
		expect(cellDiffOf(page, 'virtual')).toBeUndefined();
		expect(cellDiffOf(undefined, 'url')).toBeUndefined();
		expect(cellDiffOf({}, 'meta:title')).toBeUndefined();
	});

	test('does not take a key that is a property of every object for a difference', () => {
		expect(cellDiffOf({ meta: {} }, 'meta:constructor')).toBeUndefined();
		expect(cellDiffOf({ meta: {} }, 'meta:__proto__')).toBeUndefined();
		expect(cellDiffOf({ meta: {} }, 'meta:toString')).toBeUndefined();
	});
});

describe('revertKeyOf', () => {
	test('is the key of the metadata, and null for the url that a key makes', () => {
		expect(revertKeyOf('meta:title')).toEqual({ key: 'title' });
		expect(revertKeyOf('url')).toEqual({ key: null });
	});

	test('is nothing for the columns that are put back by no key', () => {
		expect(revertKeyOf('inputPath')).toBeNull();
		expect(revertKeyOf('virtual')).toBeNull();
	});
});

describe('withPageDiff', () => {
	const before: Diffs = {
		head: { oid: OID },
		version: 1,
		pages: { '/a/': page, '/b/': { meta: { x: { kind: 'added', revertible: true } } } },
		columns: ['gone'],
	};

	test('takes the answer for a page in place of what was known of it', () => {
		const answer: Diffs = {
			head: { oid: OID },
			version: 2,
			pages: { '/a/': { meta: { title: { kind: 'added', revertible: true } } } },
			columns: [],
		};
		const next = withPageDiff(before, ['/a/'], answer);
		expect(next?.pages['/a/']).toEqual(answer.pages['/a/']);
		expect(next?.pages['/b/']).toEqual(before.pages['/b/']);
		expect(next?.version).toBe(2);
		// a column that HEAD has and no page has now stays until the list is read again
		expect(next?.columns).toEqual(['gone']);
	});

	test('drops a page that does not differ any more', () => {
		const answer: Diffs = { head: { oid: OID }, version: 3, pages: {}, columns: [] };
		const next = withPageDiff(before, ['/a/'], answer);
		expect(next?.pages['/a/']).toBeUndefined();
		expect(Object.keys(next?.pages ?? {})).toEqual(['/b/']);
	});

	test('adds the columns the answer brings, once', () => {
		const answer: Diffs = {
			head: { oid: OID },
			version: 3,
			pages: {},
			columns: ['gone', 'other'],
		};
		expect(withPageDiff(before, ['/a/'], answer)?.columns).toEqual(['gone', 'other']);
	});

	test('is nothing when there is no answer, and when nothing was known of the rest of the window', () => {
		const answer: Diffs = { head: { oid: OID }, version: 3, pages: {}, columns: [] };
		expect(withPageDiff(before, ['/a/'], null)).toBeNull();
		// the answer for one page must not become what is shown for all of them
		expect(withPageDiff(null, ['/a/'], answer)).toBeNull();
	});

	test('is nothing when the answer is for another commit', () => {
		const other: Diffs = {
			head: { oid: 'b'.repeat(40) },
			version: 3,
			pages: {},
			columns: [],
		};
		expect(withPageDiff(before, ['/a/'], other)).toBeNull();
	});
});

describe('originLabel and originName', () => {
	const t = translator('en');
	const ja = translator('ja');

	test('the label is written only for the sidecar and pages.overrides', () => {
		expect(originLabel('inFile', t)).toBeNull();
		expect(originLabel('sidecar', t)).toBe('sidecar');
		expect(originLabel('overrides', t)).toBe('overrides');
		expect(originLabel('sidecar', ja)).toBe('sidecar');
	});

	test('the name says the file', () => {
		expect(originName('inFile', 'data/o.json', t)).toBe('the page file');
		expect(originName('sidecar', 'data/o.json', t)).toBe('the sidecar (.json)');
		expect(originName('overrides', 'data/o.json', t)).toBe('data/o.json');
		expect(originName('inFile', null, ja)).toBe('ページのファイル');
		expect(originName('sidecar', null, ja)).toBe('sidecar（.json）');
	});

	test('pages.overrides is named by its own name when the screen was not told the file', () => {
		expect(originName('overrides', null, t)).toBe('pages.overrides');
	});
});

describe('diffNote', () => {
	const t = translator('en');

	test('says the kind, the value of HEAD, and how it is put back', () => {
		expect(diffNote({ kind: 'modified', head: 'Old', revertible: true }, t)).toBe(
			'Changed from HEAD (HEAD: Old). Alt+Backspace puts it back',
		);
		expect(diffNote({ kind: 'added', revertible: true }, t)).toBe(
			'Added since HEAD. Alt+Backspace puts it back',
		);
		expect(diffNote({ kind: 'deleted', head: ['a', 1], revertible: true }, t)).toBe(
			'Deleted since HEAD (HEAD: ["a",1]). Alt+Backspace puts it back',
		);
	});

	test('does not say it can be put back when it cannot', () => {
		expect(diffNote({ kind: 'added', revertible: false }, t)).toBe('Added since HEAD');
	});

	test('says the value of HEAD in Japanese too, and an empty text as one', () => {
		const ja = translator('ja');
		expect(diffNote({ kind: 'modified', head: '', revertible: false }, ja)).toBe(
			'HEAD から変更（HEAD: ""）',
		);
	});
});

describe('valueText', () => {
	test('is a text as it is, and an empty one in quotes', () => {
		expect(valueText('Old', '(none)')).toBe('Old');
		expect(valueText('', '(none)')).toBe('""');
	});

	test('is any other value as JSON', () => {
		expect(valueText(['a', 1], '(none)')).toBe('["a",1]');
		expect(valueText(true, '(none)')).toBe('true');
		expect(valueText(null, '(none)')).toBe('null');
		expect(valueText({ a: 1 }, '(none)')).toBe('{"a":1}');
	});

	test('is what is given for a cell that has no value', () => {
		expect(valueText(undefined, '(none)')).toBe('(none)');
	});
});

describe('withPageDiff keeps the list of columns as it was when nothing is new', () => {
	test('the same list, not a copy', () => {
		const known: Diffs = { head: { oid: OID }, version: 1, pages: {}, columns: ['gone'] };
		const next = withPageDiff(known, ['/a/'], {
			head: { oid: OID },
			version: 2,
			pages: {},
			columns: ['gone'],
		});
		expect(next?.columns).toBe(known.columns);
	});
});

describe('writeNames', () => {
	const t = translator('en');

	test('names the files a revert writes, in a list', () => {
		expect(writeNames(['inFile', 'sidecar'], 'data/o.json', t)).toBe(
			'the page file, the sidecar (.json)',
		);
		expect(writeNames(['overrides'], 'data/o.json', t)).toBe('data/o.json');
		expect(writeNames(['inFile', 'sidecar', 'overrides'], null, translator('ja'))).toBe(
			'ページのファイル, sidecar（.json）, pages.overrides',
		);
	});

	test('is nothing when the server did not say', () => {
		expect(writeNames(undefined, null, t)).toBeNull();
		expect(writeNames([], null, t)).toBeNull();
	});
});

describe('revertFailureOf', () => {
	test.each([
		['conflict', { note: null, rereadFiles: true, marks: 'keep' }],
		['headMoved', { note: 'diff.headMoved', rereadFiles: false, marks: 'read' }],
		['noHead', { note: 'diff.noHead', rereadFiles: false, marks: 'drop' }],
		['notEditable', { note: null, rereadFiles: false, marks: 'keep' }],
		['network', { note: null, rereadFiles: false, marks: 'keep' }],
	] as const)('%s', (code, expected) => {
		expect(revertFailureOf(code)).toEqual(expected);
	});

	test('every note is a message in both languages', () => {
		for (const code of ['headMoved', 'noHead']) {
			const note = revertFailureOf(code).note;
			expect(note).not.toBeNull();
			expect(note === null ? '' : translator('ja')(note)).not.toBe(note);
		}
	});
});

describe('diffNote cuts a long value between characters', () => {
	test('a value that ends in a character of two units is not left with half of it', () => {
		const t = translator('en');
		// 79 characters and then one that takes two units of a string: the cut is after the 80th
		const head = `${'a'.repeat(79)}😀${'b'.repeat(10)}`;
		const note = diffNote({ kind: 'modified', head, revertible: false }, t);
		expect(note).toBe(`Changed from HEAD (HEAD: ${'a'.repeat(79)}😀…)`);
		// no lone half of a pair
		expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(note)).toBe(false);
	});
});
