import type { PageInfo } from './nav.js';

import { describe, expect, test } from 'vitest';

import { getNavTree } from './nav.js';
import {
	createRng,
	outcome,
	randomPage,
	randomPages,
	randomUrl,
} from './random.test-util.js';
import { v2GetNavTree } from './v2.test-util.js';

/**
 * Adapts a v3 page to the v2 page shape (`metaData` instead of `meta`).
 * @param page - v3 page.
 * @returns The v2 page.
 */
function toV2(page: PageInfo) {
	return { url: page.url, filePathStem: page.filePathStem, metaData: page.meta } as never;
}

const IGNORE_GLOBS = [
	['/a/**'],
	['**/*.htm', '/b/*'],
	['**/c/**'],
	['/news/**', '/*.html'],
];

describe('getNavTree', () => {
	test('matches the v2 implementation over random sites, options and current pages', () => {
		const rng = createRng(10);
		let found = 0;
		let missing = 0;
		for (let i = 0; i < 3000; i++) {
			const pages = randomPages(rng);
			const currentUrl =
				pages.length > 0 && rng.chance(0.85) ? rng.pick(pages).url : randomUrl(rng);
			const options = {
				ignoreGlobs: rng.chance(0.3) ? rng.pick(IGNORE_GLOBS) : undefined,
				baseDepth: rng.chance(0.5) ? rng.int(-1, 5) : undefined,
				comparator: rng.pick([undefined, null, 'path', 'path'] as const),
				filter: rng.chance(0.3)
					? rng.pick([
							(node: { url: string }) => !node.url.includes('b'),
							(node: { meta?: { title?: string } }) => node.meta?.title !== 'Title',
							(node: { children: unknown[] }) => node.children.length > 0,
							() => false,
						])
					: undefined,
			};
			const label = `case ${i}: ${currentUrl} in ${JSON.stringify(pages.map((p) => p.url))} ${JSON.stringify(options)}`;
			const actual = outcome(() =>
				getNavTree({ currentPage: { url: currentUrl }, pages }, options as never),
			);
			const expected = outcome(() =>
				v2GetNavTree(
					{ currentPage: { url: currentUrl } as never, pages: pages.map((p) => toV2(p)) },
					options as never,
				),
			);
			expect(actual, label).toStrictEqual(expected);
			if ('value' in actual && actual.value) found++;
			else missing++;
		}
		// Both the "found" and the null / thrown paths must be well represented.
		expect(found).toBeGreaterThan(300);
		expect(missing).toBeGreaterThan(300);
	});

	test('compares equal for every current page of a fixed site at every baseDepth', () => {
		const rng = createRng(11);
		const urls = [
			'/',
			'/a/',
			'/a/b/',
			'/a/b/c/',
			'/a/b/c/d.html',
			'/a/b/e.html',
			'/a/f.html',
			'/g.html',
			'/h/i/j/index.html',
			'/h/i/j/k/l/m.html',
		];
		const pages = urls.map((url) => randomPage(rng, url));
		for (const page of pages) {
			for (const baseDepth of [undefined, -1, 0, 1, 2, 3, 4, 9]) {
				for (const comparator of [null, 'path'] as const) {
					const actual = getNavTree(
						{ currentPage: page, pages },
						{ baseDepth, comparator },
					);
					const expected = v2GetNavTree(
						{ currentPage: page as never, pages: pages.map((p) => toV2(p)) },
						{ baseDepth, comparator },
					);
					expect(actual, `${page.url} depth ${baseDepth}`).toStrictEqual(expected);
				}
			}
		}
	});

	test('titles: trimmed title, __NO_TITLE__ for a page without one, NOT FOUND for virtual nodes', () => {
		const pages: PageInfo[] = [
			{ url: '/', filePathStem: '/index', meta: { title: '  Home  ' } },
			{ url: '/a/b.html', filePathStem: '/a/b', meta: {} },
		];
		const tree = getNavTree(
			{ currentPage: { url: '/a/b.html' }, pages },
			{ baseDepth: 0 },
		);
		expect(tree?.meta?.title).toBe('Home');
		expect(tree?.children[0]?.meta?.title).toBe('⛔️ NOT FOUND (/a/)');
		expect(tree?.children[0]?.children[0]?.meta?.title).toBe('__NO_TITLE__');
		expect(tree?.children[0]?.children[0]?.meta).toStrictEqual({ title: '__NO_TITLE__' });
	});

	test('returns null when the current page is not in the list', () => {
		const pages: PageInfo[] = [{ url: '/', filePathStem: '/index', meta: {} }];
		expect(getNavTree({ currentPage: { url: '/zzz/' }, pages })).toBeNull();
	});

	test('with duplicate URLs the first page supplies the meta, as in v2', () => {
		const pages: PageInfo[] = [
			{ url: '/', filePathStem: '/index', meta: { title: 'First' } },
			{ url: '/', filePathStem: '/index', meta: { title: 'Second' } },
		];
		expect(getNavTree({ currentPage: { url: '/' }, pages })?.meta?.title).toBe('First');
	});
});
