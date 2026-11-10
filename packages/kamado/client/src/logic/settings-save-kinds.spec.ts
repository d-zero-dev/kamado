import { describe, expect, test } from 'vitest';

import { mergePatches } from './settings-save.js';

const kindsA = { 'meta:a': { type: 'enum' as const, options: ['x'] } };
const kindsB = { 'meta:b': { type: 'enum' as const, options: ['y'] } };

describe('mergePatches with the kinds', () => {
	test('keeps the kinds of an earlier change that failed through a later change of another field', () => {
		expect(
			mergePatches({ project: { kinds: kindsA } }, { project: { pageSize: 100 } }),
		).toEqual({ project: { kinds: kindsA, pageSize: 100 } });
	});

	test('takes the kinds of the later change whole, not a mixture of the two', () => {
		expect(
			mergePatches({ project: { kinds: kindsA } }, { project: { kinds: kindsB } }),
		).toEqual({ project: { kinds: kindsB } });
	});

	test('takes null of the later change as taking every kind away', () => {
		expect(
			mergePatches({ project: { kinds: kindsA } }, { project: { kinds: null } }),
		).toEqual({ project: { kinds: null } });
	});

	test('keeps the layout of the columns apart from the kinds', () => {
		expect(
			mergePatches(
				{ project: { kinds: kindsA } },
				{ project: { columns: { pinned: ['url'] } } },
			),
		).toEqual({ project: { kinds: kindsA, columns: { pinned: ['url'] } } });
	});
});
