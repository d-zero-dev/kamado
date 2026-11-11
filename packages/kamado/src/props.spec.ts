import { describe, expect, test } from 'vitest';

import { basePathOf } from './base-path.js';
import { createProps, type PageEntry, type RenderContext } from './props.js';

describe('basePathOf', () => {
	test.each([
		[null, '/'],
		['', '/'],
		['/sub/', '/sub/'],
		['https://example.com/sub/', '/sub/'],
		['https://example.com', '/'],
		['http://example.test/a/b/', '/a/b/'],
	])('%j is %j', (baseURL, expected) => {
		expect(basePathOf(baseURL)).toBe(expected);
	});
});

/**
 * @param url - Page URL
 * @param title - Page title
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
		baseURL: '/sub/',
		siteName: 'Site',
		siteNameEn: null,
		name: null,
		version: null,
	},
	data: {},
	pages: [page('/sub/', 'Home'), page('/sub/a/', 'A')],
};

describe('createProps', () => {
	test('returns the page props shape with a breadcrumbs array', () => {
		const props = createProps(context, 1);
		expect(props.page.url).toBe('/sub/a/');
		expect(props.meta).toEqual({ title: 'A' });
		expect(props.site.siteName).toBe('Site');
		expect(Array.isArray(props.breadcrumbs)).toBe(true);
		expect(props.breadcrumbs.map((item) => item.href)).toEqual(['/sub/', '/sub/a/']);
		expect(typeof props.nav).toBe('function');
		expect(typeof props.titleList).toBe('function');
		expect(typeof props.formatDate).toBe('function');
	});

	test('adds content for a layout', () => {
		const props = createProps(context, 0, { content: '<p>x</p>' });
		expect(props.content).toBe('<p>x</p>');
	});

	test('passes site.siteName to titleList by default', () => {
		expect(createProps(context, 1).titleList({ baseURL: '/sub/' })).toBe('ASite');
	});
});
