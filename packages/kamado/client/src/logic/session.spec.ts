import type { Row, Rows } from '../types.js';

import { describe, expect, test } from 'vitest';

import {
	applyEdited,
	createQueue,
	editBlockedReason,
	focusAfterLoad,
	pageToReadInstead,
	rowByUrl,
	shouldWrite,
} from './session.js';

/**
 * A row with a URL and a title.
 * @param url - The URL
 * @param title - The title
 */
function row(url: string, title = 'T'): Row {
	return {
		url,
		inputPath: `${url.slice(1)}index.html`,
		outputPath: `${url.slice(1)}index.html`,
		virtual: false,
		depth: 1,
		parent: '/',
		hashes: { input: `h-${url}`, sidecar: null },
		meta: { title: { value: title, origin: 'inFile', editable: true } },
	};
}

const ROWS: Rows = {
	version: 1,
	total: 2,
	columns: ['title'],
	overridesHash: 'o1',
	pages: [row('/a/'), row('/b/')],
	warnings: [],
};

describe('editBlockedReason', () => {
	test('an edit can be sent on a list that is shown', () => {
		expect(editBlockedReason('ok')).toBeNull();
	});
	test('an edit made while the list is being read says that nothing was written', () => {
		expect(editBlockedReason('busy')).toContain('nothing was written');
		expect(editBlockedReason('busy')).toContain('being read again');
	});
	test('a list that could not be read says to read it again', () => {
		expect(editBlockedReason('failed')).toContain('Read again');
		expect(editBlockedReason('failed')).toContain('nothing was written');
	});
});

describe('rowByUrl', () => {
	test('finds a page by its URL, wherever it is in the list', () => {
		expect(rowByUrl(ROWS, '/b/')?.url).toBe('/b/');
		const reordered = { ...ROWS, pages: [...ROWS.pages].toReversed() };
		expect(rowByUrl(reordered, '/b/')?.url).toBe('/b/');
	});
	test('a page that is not there, or no list, is nothing', () => {
		expect(rowByUrl(ROWS, '/c/')).toBeUndefined();
		expect(rowByUrl(null, '/a/')).toBeUndefined();
	});
});

describe('applyEdited', () => {
	const edited = {
		version: 2,
		overridesHash: 'o2',
		page: row('/a/', 'Changed'),
	};
	test('puts the page as the files hold it and the hash every row sends', () => {
		const next = applyEdited(ROWS, '/a/', edited);
		expect(next.version).toBe(2);
		expect(next.overridesHash).toBe('o2');
		expect(next.pages[0]?.meta.title?.value).toBe('Changed');
		expect(next.pages[1]).toBe(ROWS.pages[1]);
	});
	test('names the page by the URL it had, so that a moved page is replaced by the moved one', () => {
		const next = applyEdited(ROWS, '/a/', { ...edited, page: row('/z/') });
		expect(next.pages.map((p) => p.url)).toEqual(['/z/', '/b/']);
	});
	test('leaves the list it was given as it was', () => {
		applyEdited(ROWS, '/a/', edited);
		expect(ROWS.version).toBe(1);
		expect(ROWS.pages[0]?.meta.title?.value).toBe('T');
	});
});

describe('focusAfterLoad', () => {
	const urls = ['/a/', '/b/', '/c/'];
	test('stays where it was when nothing was moved', () => {
		expect(focusAfterLoad(urls, 1, null)).toEqual({ row: 1, said: null });
	});
	test('is held to the rows there are now', () => {
		expect(focusAfterLoad(urls, 9, null)).toEqual({ row: 2, said: null });
		expect(focusAfterLoad([], 4, null)).toEqual({ row: 0, said: null });
	});
	test('goes to the page that was moved, when it is on this page', () => {
		expect(focusAfterLoad(urls, 0, '/c/')).toEqual({ row: 2, said: 'Moved to /c/' });
	});
	test('says where the page went when it is not on this page, and stays', () => {
		expect(focusAfterLoad(urls, 1, '/z/')).toEqual({
			row: 1,
			said: 'Moved to /z/ (not on this page)',
		});
	});
});

describe('pageToReadInstead', () => {
	test('a page with rows, or the first page, is fine', () => {
		expect(pageToReadInstead(2, 10, 1001, 500)).toBeNull();
		expect(pageToReadInstead(0, 0, 0, 500)).toBeNull();
		expect(pageToReadInstead(0, 0, 10, 500)).toBeNull();
	});
	test('a page past the end, when the list has rows, is the last page', () => {
		expect(pageToReadInstead(3, 0, 1001, 500)).toBe(2);
	});
	test('a page with no rows and a list with none is not a page to go back from', () => {
		expect(pageToReadInstead(3, 0, 0, 500)).toBeNull();
	});
});

describe('shouldWrite', () => {
	test('a changed value of a key the page has is written', () => {
		expect(shouldWrite({ value: 'A' }, 'B', 'A', 'B')).toBe(true);
	});
	test('a cell that was opened and left is not written', () => {
		expect(shouldWrite({ value: 'A' }, 'A', 'A', 'A')).toBe(false);
	});
	test('a date with a time that was opened and left is not cut down to its day', () => {
		expect(
			shouldWrite(
				{ value: '2026-01-02T03:04:05' },
				'2026-01-02',
				'2026-01-02',
				'2026-01-02',
			),
		).toBe(false);
	});
	test('null that was opened and left is not turned into an empty text', () => {
		expect(shouldWrite({ value: null }, '', '', '')).toBe(false);
	});
	test('text that comes to the same value as before is not written', () => {
		expect(shouldWrite({ value: [1, 2] }, '[1,2]', '[\n  1,\n  2\n]', [1, 2])).toBe(
			false,
		);
	});
	test('a key the page lacks is given a value, not an empty text or null', () => {
		expect(shouldWrite(null, 'x', '', 'x')).toBe(true);
		expect(shouldWrite(null, '', '', '')).toBe(false);
		expect(shouldWrite(null, '', '', null)).toBe(false);
	});
});

describe('createQueue', () => {
	/**
	 * A promise made to be settled by hand.
	 */
	function gate() {
		let open = () => {};
		const promise = new Promise<void>((resolve) => {
			open = resolve;
		});
		return { promise, open };
	}

	test('runs the tasks one after another, in the order they were put', async () => {
		const queue = createQueue();
		const log: string[] = [];
		const first = gate();
		queue.enqueue(async () => {
			log.push('first starts');
			await first.promise;
			log.push('first ends');
		});
		queue.enqueue(() => {
			log.push('second starts');
			return Promise.resolve();
		});
		await Promise.resolve();
		expect(log).toEqual(['first starts']);
		first.open();
		await queue.idle();
		expect(log).toEqual(['first starts', 'first ends', 'second starts']);
	});
	test('a task that throws does not stop the ones after it', async () => {
		const queue = createQueue();
		const log: string[] = [];
		queue.enqueue(() => Promise.reject(new Error('no')));
		queue.enqueue(() => {
			log.push('after');
			return Promise.resolve();
		});
		await queue.idle();
		expect(log).toEqual(['after']);
	});
	test('is idle at once when nothing was put', async () => {
		await expect(createQueue().idle()).resolves.toBeUndefined();
	});
});
