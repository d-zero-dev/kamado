import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import * as screen from '../../client/src/logic/column-defaults.js';

import { createSettingsStore, DEFAULT_PAGE_SIZE, parsePatch } from './settings.js';

const KEY = '/home/u/site/kamado.config.jsonc';

let dir: string;
let file: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'kamado-ui-reset-'));
	file = path.join(dir, 'ui-settings.json');
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe('the change the screen sends to put the settings back to the defaults', () => {
	test('the screen and the server have the same rows per page by default', () => {
		expect(screen.DEFAULT_PAGE_SIZE).toBe(DEFAULT_PAGE_SIZE);
	});

	test('is a change the server takes, as it is', () => {
		const patch = screen.resetPatch();
		expect(parsePatch(structuredClone(patch))).toEqual(patch);
	});

	test('leaves the project with nothing but the default rows per page, and keeps the language', async () => {
		const store = createSettingsStore(file, KEY);
		await store.open();
		await store.update({ global: { locale: 'ja' } });
		await store.update({
			project: {
				pageSize: 1000,
				sort: { key: 'meta:title', desc: true },
				columns: {
					order: ['url', 'meta:title'],
					pinned: ['meta:title'],
					widths: { url: 300 },
				},
				kinds: { 'meta:layout': { type: 'enum', options: ['a', 'b'] } },
			},
		});
		const view = await store.update(screen.resetPatch());
		expect(view.global.locale).toBe('ja');
		expect(view.project?.pageSize).toBe(DEFAULT_PAGE_SIZE);
		expect(view.project).not.toHaveProperty('sort');
		expect(view.project).not.toHaveProperty('columns');
		expect(view.project).not.toHaveProperty('kinds');
		const saved = JSON.parse(await readFile(file, 'utf8')) as {
			projects: Record<string, Record<string, unknown>>;
		};
		expect(Object.keys(saved.projects[KEY] ?? {}).toSorted()).toEqual([
			'pageSize',
			'updatedAt',
		]);
	});
});
