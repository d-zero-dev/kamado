import { describe, expect, test } from 'vitest';

import {
	displayChange,
	displayFailure,
	displayLog,
	displayProblem,
	MAX_LOG_LINE,
	MAX_PREVIEW,
	previewValue,
} from './display.js';

const ESC = String.fromCodePoint(27);
const RLO = String.fromCodePoint(8238);

describe('displayLog', () => {
	test('spells out what a terminal would obey, so a line cannot fake another', () => {
		expect(displayLog({ type: 'warn', message: `ok\n[error] fake${ESC}[2J` })).toEqual({
			type: 'warn',
			message: String.raw`ok\n[error] fake\x1B[2J`,
		});
	});

	test('cuts a line that is too long', () => {
		const shown = displayLog({ type: 'info', message: 'x'.repeat(MAX_LOG_LINE + 50) });
		// oxlint-disable-next-line typescript/no-misused-spread -- the code points on purpose, not the units of a string
		expect([...shown.message]).toHaveLength(MAX_LOG_LINE);
		expect(shown.message.endsWith('…')).toBe(true);
	});
});

describe('previewValue', () => {
	test('is the JSON of the value', () => {
		expect(previewValue({ a: [1, 'x'] })).toBe('{"a":[1,"x"]}');
		expect(previewValue(null)).toBe('null');
		expect(previewValue('text')).toBe('"text"');
	});

	test('is cut, and has no control character', () => {
		// oxlint-disable-next-line typescript/no-misused-spread -- the code points on purpose, not the units of a string
		expect([...previewValue('y'.repeat(1000))]).toHaveLength(MAX_PREVIEW);
		expect(previewValue(`a${RLO}b${ESC}`)).not.toContain(RLO);
		expect(previewValue(`a${RLO}b${ESC}`)).not.toContain(ESC);
	});
});

describe('displayChange', () => {
	test('makes every text of a change safe, and a value a preview', () => {
		expect(
			displayChange({
				kind: 'meta',
				url: `/a/${ESC}`,
				key: `k\n`,
				before: { n: 1 },
				after: undefined,
			}),
		).toEqual({
			kind: 'meta',
			url: String.raw`/a/\x1B`,
			key: String.raw`k\n`,
			before: '{"n":1}',
			after: 'undefined',
		});
	});

	test('leaves out a value a change does not have', () => {
		const added = displayChange({ kind: 'meta', url: '/a/', key: 'k', after: 1 });
		expect(added).toEqual({ kind: 'meta', url: '/a/', key: 'k', after: '1' });
		expect('before' in added).toBe(false);
		const removed = displayChange({ kind: 'meta', url: '/a/', key: 'k', before: 1 });
		expect('after' in removed).toBe(false);
	});

	test.each([
		[
			{
				kind: 'added',
				url: `/n${ESC}/`,
				virtual: false,
				inputPath: `n${RLO}.html`,
				keys: 2,
			},
			{
				kind: 'added',
				url: String.raw`/n\x1B/`,
				virtual: false,
				inputPath: `n\\u202E.html`,
				keys: 2,
			},
		],
		[
			{ kind: 'deleted', url: '/d/', inputPath: null },
			{ kind: 'deleted', url: '/d/', inputPath: null },
		],
		[
			{ kind: 'movedUrl', from: `/a${ESC}/`, to: '/b/' },
			{ kind: 'movedUrl', from: String.raw`/a\x1B/`, to: '/b/' },
		],
		[
			{ kind: 'movedFile', url: '/a/', from: null, to: `x\ny.html` },
			{ kind: 'movedFile', url: '/a/', from: null, to: String.raw`x\ny.html` },
		],
		[
			{ kind: 'virtualized', url: '/v/', inputPath: 'v.html' },
			{ kind: 'virtualized', url: '/v/', inputPath: 'v.html' },
		],
		[
			{ kind: 'materialized', url: '/m/', inputPath: null },
			{ kind: 'materialized', url: '/m/', inputPath: null },
		],
	] as const)('%j', (change, shown) => {
		expect(displayChange(change)).toEqual(shown);
	});
});

describe('displayProblem and displayFailure', () => {
	test('a problem is one safe line', () => {
		expect(
			displayProblem({ row: 1, url: null, message: `row 1: bad${ESC}[0m\nrow 2: fake` }),
		).toBe(String.raw`row 1: bad\x1B[0m\nrow 2: fake`);
	});

	test('a failure keeps the lines of its stack and spells out each', () => {
		expect(
			displayFailure({ message: `no${ESC}`, stack: `Error: no\n    at f${ESC}[0m` }),
		).toEqual({ message: String.raw`no\x1B`, stack: 'Error: no\n    at f\\x1B[0m' });
		expect(displayFailure({ message: 'm', stack: null })).toEqual({
			message: 'm',
			stack: null,
		});
	});
});
