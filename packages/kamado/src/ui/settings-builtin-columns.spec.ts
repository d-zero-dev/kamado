import { describe, expect, test } from 'vitest';

import * as screen from '../../client/src/logic/layout.js';

import {
	BUILTIN_COLUMNS,
	COLUMN_NAMES,
	isSortKey,
	parsePatch,
	parseSettings,
} from './settings.js';

const KEY = '/home/u/site/kamado.config.jsonc';

describe('the columns every row has', () => {
	test('are the same on the screen and on the server, in the same order (the screen cannot import this module, so it writes them again)', () => {
		expect(screen.columnIds([])).toEqual([...BUILTIN_COLUMNS]);
	});

	test('are named in the message that refuses a column, as the RFC lists them', () => {
		expect(COLUMN_NAMES).toBe(
			'url, virtual, inputPath, order, outputPath, parent, depth or meta:<key>',
		);
	});

	test.each(['order', 'outputPath', 'parent', 'depth'])(
		'%s is taken as a sort and in the three lists of a layout',
		(id) => {
			expect(isSortKey(id)).toBe(true);
			const patch = parsePatch({
				project: {
					sort: { key: id, desc: true },
					columns: { order: ['url', id], pinned: [id], widths: { [id]: 120 } },
				},
			});
			expect(patch.project).toEqual({
				sort: { key: id, desc: true },
				columns: { order: ['url', id], pinned: [id], widths: { [id]: 120 } },
			});
		},
	);

	test('are kept when the settings file is read', () => {
		const read = parseSettings(
			JSON.stringify({
				version: 1,
				global: { locale: 'auto' },
				projects: {
					[KEY]: {
						updatedAt: '2026-01-02T03:04:05.000Z',
						pageSize: 500,
						sort: { key: 'order', desc: true },
						columns: {
							order: ['depth', 'url', 'parent'],
							pinned: ['outputPath'],
							widths: { order: 100 },
						},
					},
				},
			}),
		);
		expect(read.state).toBe('ok');
		expect(read.state === 'ok' ? read.settings.projects[KEY] : undefined).toMatchObject({
			sort: { key: 'order', desc: true },
			columns: {
				order: ['depth', 'url', 'parent'],
				pinned: ['outputPath'],
				widths: { order: 100 },
			},
		});
	});

	test('a name that only looks like one is not a column', () => {
		for (const id of ['Order', 'output', 'hashes', 'meta', 'meta:']) {
			expect(isSortKey(id), id).toBe(false);
		}
	});
});
