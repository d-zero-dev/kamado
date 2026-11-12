import { describe, expect, test } from 'vitest';

import {
	firstTab,
	hiddenLines,
	isFinished,
	MAX_HELD_LINES,
	mergeLog,
	NO_LOG,
	operationLabel,
	tabsOf,
} from './sync.js';

const ZERO = {
	deleted: 0,
	movedUrl: 0,
	added: 0,
	meta: 0,
	movedFile: 0,
	virtualized: 0,
	materialized: 0,
};

describe('operationLabel', () => {
	test('is the text, the one for the language, the English one, then the name', () => {
		expect(operationLabel({ name: 'import', label: 'Import' }, 'ja')).toBe('Import');
		expect(
			operationLabel({ name: 'import', label: { ja: '取り込む', en: 'Import' } }, 'ja'),
		).toBe('取り込む');
		expect(operationLabel({ name: 'import', label: { en: 'Import' } }, 'ja')).toBe(
			'Import',
		);
		expect(operationLabel({ name: 'import', label: { fr: 'Importer' } }, 'ja')).toBe(
			'import',
		);
	});

	test('is the name for a label that is empty or null', () => {
		expect(operationLabel({ name: 'import', label: '' }, 'en')).toBe('import');
		expect(operationLabel({ name: 'import', label: {} }, 'en')).toBe('import');
		expect(operationLabel({ name: 'import', label: null }, 'en')).toBe('import');
	});

	test('does not read a language from the prototype of the label', () => {
		expect(operationLabel({ name: 'import', label: {} }, 'constructor')).toBe('import');
	});
});

describe('isFinished', () => {
	test.each([
		['running', false],
		['writing', false],
		['failed', true],
		['cancelled', true],
		['nochange', true],
		['invalid', true],
		['review', true],
		['applied', true],
		['conflict', true],
		['refused', true],
	] as const)('%s is %s', (status, finished) => {
		expect(isFinished(status)).toBe(finished);
	});
});

describe('tabsOf', () => {
	test('has four tabs always, and a kind with nothing is faint and cannot be chosen', () => {
		expect(tabsOf({ ...ZERO, movedUrl: 2, meta: 1 })).toEqual([
			{ kind: 'deleted', count: 0, disabled: true },
			{ kind: 'movedUrl', count: 2, disabled: false },
			{ kind: 'added', count: 0, disabled: true },
			{ kind: 'meta', count: 1, disabled: false },
		]);
	});

	test('has the other kinds only when there is one', () => {
		const kinds = tabsOf({ ...ZERO, movedFile: 1, materialized: 3 }).map(
			(tab) => tab.kind,
		);
		expect(kinds).toEqual([
			'deleted',
			'movedUrl',
			'added',
			'meta',
			'movedFile',
			'materialized',
		]);
		expect(tabsOf(ZERO).map((tab) => tab.kind)).toEqual([
			'deleted',
			'movedUrl',
			'added',
			'meta',
		]);
	});
});

describe('firstTab', () => {
	test('is the first that has a change', () => {
		expect(firstTab(tabsOf({ ...ZERO, added: 4, meta: 1 }))).toBe('added');
		expect(firstTab(tabsOf({ ...ZERO, virtualized: 1 }))).toBe('virtualized');
	});
	test('is none when nothing changes', () => {
		expect(firstTab(tabsOf(ZERO))).toBeNull();
	});
});

describe('mergeLog', () => {
	const line = (n: number) => ({ type: 'info' as const, message: `line ${n}` });

	test('adds the lines an answer brings, and tells where to ask next', () => {
		const first = mergeLog(NO_LOG, { log: [line(0), line(1)], next: 2, dropped: 0 });
		expect(first).toEqual({ lines: [line(0), line(1)], next: 2, dropped: 0 });
		const second = mergeLog(first, { log: [line(2)], next: 3, dropped: 0 });
		expect(second.lines).toHaveLength(3);
		expect(second.next).toBe(3);
	});

	test('keeps what it holds when an answer brings nothing', () => {
		const held = mergeLog(NO_LOG, { log: [line(0)], next: 1, dropped: 0 });
		expect(mergeLog(held, { log: [], next: 1, dropped: 0 })).toEqual(held);
	});

	test('holds no more than the server keeps, the last lines', () => {
		const many = Array.from({ length: MAX_HELD_LINES + 5 }, (_, i) => line(i));
		const held = mergeLog(NO_LOG, { log: many, next: many.length, dropped: 0 });
		expect(held.lines).toHaveLength(MAX_HELD_LINES);
		expect(held.lines[0]).toEqual(line(5));
	});

	test('does not add the lines of an answer that is not newer, and does not move back', () => {
		const held = mergeLog(NO_LOG, { log: [line(0), line(1)], next: 2, dropped: 0 });
		const again = mergeLog(held, { log: [line(0), line(1)], next: 2, dropped: 0 });
		expect(again).toEqual(held);
		const older = mergeLog(held, { log: [line(0)], next: 1, dropped: 0 });
		expect(older).toEqual(held);
	});

	test('counts what is not shown, whoever dropped it', () => {
		const dropped = mergeLog(NO_LOG, {
			log: [line(25), line(26)],
			next: 27,
			dropped: 25,
		});
		expect(hiddenLines(dropped)).toBe(25);
		expect(hiddenLines(NO_LOG)).toBe(0);
	});
});
