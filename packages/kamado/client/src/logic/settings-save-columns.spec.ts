import { describe, expect, test } from 'vitest';

import { mergePatches } from './settings-save.js';

describe('mergePatches of the layout of the columns', () => {
	test('lets the later layout replace the earlier as a whole, so the lists are never mixed', () => {
		const merged = mergePatches(
			{
				project: {
					columns: { order: ['url', 'virtual'], pinned: ['url'], widths: { url: 300 } },
				},
			},
			{ project: { columns: { pinned: [] } } },
		);
		expect(merged).toEqual({ project: { columns: { pinned: [] } } });
	});

	test('keeps the layout when only the page size is saved after it', () => {
		const merged = mergePatches(
			{ project: { columns: { pinned: ['url'] } } },
			{ project: { pageSize: 100 } },
		);
		expect(merged).toEqual({ project: { columns: { pinned: ['url'] }, pageSize: 100 } });
	});
});
