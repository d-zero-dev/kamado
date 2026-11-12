import type { Row } from '../types.js';

import { describe, expect, test } from 'vitest';

import { columnHoldsArrays, editKindOf, inferredKinds, sameKinds } from './columns.js';

/**
 * A row with these values of metadata.
 * @param url
 * @param meta
 */
function row(url: string, meta: Record<string, unknown>): Row {
	return {
		url,
		inputPath: `src${url}`,
		outputPath: url,
		virtual: false,
		depth: 1,
		parent: '/',
		hashes: { input: 'h', sidecar: null },
		meta: Object.fromEntries(
			Object.entries(meta).map(([key, value]) => [
				key,
				{ value, origin: 'inFile', editable: true },
			]),
		),
	};
}

describe('editKindOf', () => {
	const enumKind = { type: 'enum' as const, options: ['a', 'b'] };

	test('is the kind of the value when the column is not an enum', () => {
		expect(editKindOf(row('/', { a: true }), 'a', new Map()).kind).toBe('boolean');
		expect(editKindOf(row('/', { a: ['x'] }), 'a', new Map()).kind).toBe('list');
		expect(editKindOf(row('/', { a: [{ x: 1 }] }), 'a', new Map()).kind).toBe('json');
	});

	test('is an enum for any value that a choice can be made of, whatever kind it was', () => {
		for (const value of ['a', 'zzz', 3, true, ['a', 'b'], [], '2026-01-02', null]) {
			expect(
				editKindOf(row('/', { a: value }), 'a', new Map(), enumKind).kind,
				String(value),
			).toBe('enum');
		}
		// A page that has no such key is chosen for too.
		expect(editKindOf(row('/', {}), 'a', new Map(), enumKind).kind).toBe('enum');
	});

	test('is JSON for a value that no choice can make, even in an enum column', () => {
		expect(editKindOf(row('/', { a: { x: 1 } }), 'a', new Map(), enumKind).kind).toBe(
			'json',
		);
		expect(editKindOf(row('/', { a: [{ x: 1 }] }), 'a', new Map(), enumKind).kind).toBe(
			'json',
		);
	});

	test('gives the cell with the kind', () => {
		const { cell } = editKindOf(row('/', { a: 'x' }), 'a', new Map());
		expect(cell?.value).toBe('x');
		expect(editKindOf(row('/', {}), 'a', new Map()).cell).toBeUndefined();
	});

	test('uses the kind a key was added or inferred as, for a page that has no value', () => {
		const hints = new Map([['a', 'boolean' as const]]);
		expect(editKindOf(row('/', {}), 'a', hints).kind).toBe('boolean');
		expect(editKindOf(row('/', { a: 'text' }), 'a', hints).kind).toBe('text');
	});
});

describe('inferredKinds', () => {
	test('call a column of booleans a boolean, so that a page without the key shows a checkbox', () => {
		const rows = [
			row('/a', { draft: true, title: 'A' }),
			row('/b', { draft: false }),
			row('/c', { title: 'C' }),
		];
		const kinds = inferredKinds(rows, ['draft', 'title'], new Map());
		expect(kinds.get('draft')).toBe('boolean');
		expect(kinds.has('title')).toBe(false);
	});

	test('do not call a column boolean when one value is not, or no page has a value', () => {
		const rows = [
			row('/a', { flag: true, mixed: true, none: null }),
			row('/b', { mixed: 'yes' }),
		];
		const kinds = inferredKinds(rows, ['flag', 'mixed', 'none', 'absent'], new Map());
		expect(kinds.get('flag')).toBe('boolean');
		expect(kinds.has('mixed')).toBe(false);
		expect(kinds.has('none')).toBe(false);
		expect(kinds.has('absent')).toBe(false);
	});

	test('keep the kind a key was added as', () => {
		const rows = [row('/a', { draft: true })];
		const kinds = inferredKinds(rows, ['draft'], new Map([['draft', 'text' as const]]));
		expect(kinds.get('draft')).toBe('text');
	});

	test('do not change the kinds that were given', () => {
		const given = new Map([['x', 'date' as const]]);
		inferredKinds([row('/a', { draft: true })], ['draft'], given);
		expect([...given.keys()]).toEqual(['x']);
	});

	test('look at a key called __proto__ as a key', () => {
		const rows = [row('/a', { ['__proto__']: true })];
		const kinds = inferredKinds(rows, ['__proto__'], new Map());
		expect(kinds.get('__proto__')).toBe('boolean');
	});
});

describe('sameKinds', () => {
	test('is true for maps that hold the same kinds, whatever the order', () => {
		const a = new Map([
			['a', 'boolean' as const],
			['b', 'date' as const],
		]);
		const b = new Map([
			['b', 'date' as const],
			['a', 'boolean' as const],
		]);
		expect(sameKinds(a, b)).toBe(true);
		expect(sameKinds(new Map(), new Map())).toBe(true);
	});

	test('is false when a key, or the kind of a key, differs', () => {
		expect(sameKinds(new Map([['a', 'boolean' as const]]), new Map())).toBe(false);
		expect(
			sameKinds(new Map([['a', 'boolean' as const]]), new Map([['a', 'text' as const]])),
		).toBe(false);
		expect(
			sameKinds(
				new Map([['a', 'boolean' as const]]),
				new Map([['b', 'boolean' as const]]),
			),
		).toBe(false);
	});
});

describe('columnHoldsArrays', () => {
	test('is true when a page holds an array under the key', () => {
		const rows = [row('/a', { tags: 'x' }), row('/b', { tags: ['y'] }), row('/c', {})];
		expect(columnHoldsArrays(rows, 'tags')).toBe(true);
	});

	test('is false when no page does', () => {
		const rows = [row('/a', { tags: 'x' }), row('/b', { tags: null }), row('/c', {})];
		expect(columnHoldsArrays(rows, 'tags')).toBe(false);
		expect(columnHoldsArrays([], 'tags')).toBe(false);
		expect(columnHoldsArrays(rows, 'toString')).toBe(false);
	});
});
