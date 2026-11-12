import { describe, expect, test } from 'vitest';

import { createUiApp } from './app.js';

const ROOTS = {
	rootDir: '/home/u/site',
	inputDir: '/home/u/site/src',
	outputDir: '/home/u/site/htdocs',
};

/**
 * An app over a core that answers a page of rows with the given `keys`.
 * @param keys
 */
function setup(keys: unknown) {
	const editor = {
		handle: 'h1',
		uiPages: () =>
			JSON.stringify({
				version: 1,
				total: 0,
				columns: [],
				layouts: null,
				keys,
				overridesHash: null,
				pages: [],
				warnings: [],
			}),
		uiRefresh: () => '{}',
		uiEdit: () => '{}',
	};
	return createUiApp(editor, {
		uiDir: '/nowhere',
		token: 'a-token-for-the-test',
		roots: ROOTS,
	});
}

describe('how the config presents the keys (`ui.keys`) through /api/pages', () => {
	test('reaches the screen as the core says it, labels per language included', async () => {
		const keys = {
			title: {
				label: { ja: 'タイトル', en: 'Title' },
				description: 'Used for <title>',
			},
			navHidden: { label: 'Hidden' },
		};
		const response = await setup(keys).request('/api/pages', {
			headers: { Host: 'localhost' },
		});
		expect(response.status).toBe(200);
		expect(((await response.json()) as { keys: unknown }).keys).toEqual(keys);
	});

	test('is the text of the config and is not told without the directories like a warning', async () => {
		const keys = { title: { description: 'Written for /home/u/site/src' } };
		const response = await setup(keys).request('/api/pages', {
			headers: { Host: 'localhost' },
		});
		expect(((await response.json()) as { keys: unknown }).keys).toEqual(keys);
	});

	test('is an empty object when the config names none', async () => {
		const response = await setup({}).request('/api/pages', {
			headers: { Host: 'localhost' },
		});
		expect(((await response.json()) as { keys: unknown }).keys).toEqual({});
	});
});
