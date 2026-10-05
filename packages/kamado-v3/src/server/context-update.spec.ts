import type { PageEntry, RenderContext } from '../props.js';

import { describe, expect, test } from 'vitest';

import { applyUpdate } from './context-update.js';

/**
 * A page entry for the tests.
 * @param url - Its URL
 * @param title - Its title
 */
function page(url: string, title: string): PageEntry {
	return {
		url,
		inputPath: `/s${url}index.html`,
		outputPath: `/o${url}index.html`,
		fileSlug: '',
		filePathStem: `${url}index`,
		extension: '.html',
		date: '2026-01-01T00:00:00.000Z',
		meta: { title },
	};
}

const context: RenderContext = {
	site: {
		host: null,
		baseURL: null,
		siteName: 'Site',
		siteNameEn: null,
		name: null,
		version: null,
	},
	data: { n: 1 },
	pages: [page('/', 'Home'), page('/a/', 'A')],
};

describe('applyUpdate', () => {
	test('replaces the pages that changed and keeps the others', () => {
		const next = applyUpdate(context, {
			pages: [[1, page('/a/', 'A2')]],
			data: null,
		});

		expect(next.pages.map((p) => p.meta['title'])).toEqual(['Home', 'A2']);
		expect(next.site).toBe(context.site);
		expect(next.data).toBe(context.data);
	});

	test('takes the new data when there is some', () => {
		const next = applyUpdate(context, { pages: [], data: { n: 2 } });

		expect(next.data).toEqual({ n: 2 });
	});

	test('returns a new context and leaves the old one as it was', () => {
		const next = applyUpdate(context, { pages: [[0, page('/', 'X')]], data: null });

		expect(next).not.toBe(context);
		expect(next.pages).not.toBe(context.pages);
		expect(context.pages[0]!.meta['title']).toBe('Home');
	});
});
