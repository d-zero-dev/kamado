import { describe, expect, test } from 'vitest';

import { english, translator } from '../i18n/translate.js';

import {
	clashesWithFixedColumn,
	columnIds,
	columnLabel,
	defaultWidth,
	emptyLayout,
	layoutOf,
	pinColumn,
	settingsOf,
} from './layout.js';
import { canSort, isColumnId } from './sort.js';

describe('the column of the key that places a page (meta:order)', () => {
	test('is a column of the keys, like the others, and the number of the place is none', () => {
		const known = columnIds(['order', 'title']);
		expect(known).toContain('meta:order');
		expect(known).not.toContain('order');
		expect(known.indexOf('meta:order')).toBeLessThan(known.indexOf('meta:title'));
	});

	test('is told by its name, with no mark of being a key (nothing fixed is called order)', () => {
		expect(clashesWithFixedColumn('meta:order')).toBe(false);
		expect(columnLabel('meta:order', english)).toBe('order');
		expect(columnLabel('meta:order', translator('ja'))).toBe('order');
	});

	test('has the width of a key, and can be pinned and named in the layout that is kept', () => {
		expect(defaultWidth('meta:order')).toBe(224);
		const known = columnIds(['order']);
		const pinned = pinColumn(emptyLayout(), known, 'meta:order');
		expect(layoutOf(known, pinned).shown.slice(0, 2)).toEqual(['url', 'meta:order']);
		expect(settingsOf(pinned, known).pinned).toEqual(['url', 'meta:order']);
	});

	test('cannot be sorted by, though the server takes it in the layout', () => {
		expect(canSort('meta:order')).toBe(false);
		expect(isColumnId('meta:order')).toBe(true);
		expect(canSort('meta:title')).toBe(true);
	});
});
