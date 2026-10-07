import type { PageInfo } from './nav.js';

import { describe, expect, test } from 'vitest';

import { getBreadcrumbs } from './breadcrumbs.js';
import { createRng, outcome, randomPage, randomPages } from './random.test-util.js';
import { titleList } from './title-list.js';
import { v2GetBreadcrumbs, v2TitleList } from './v2.test-util.js';

/**
 * Adapts a v3 page to the v2 page shape (`metaData` instead of `meta`).
 * @param page - v3 page.
 * @returns The v2 page.
 */
function toV2(page: PageInfo) {
	return { url: page.url, filePathStem: page.filePathStem, metaData: page.meta } as never;
}

const BASE_URLS = [undefined, '/', '/a/', '/a/b/', 'a', '/news', '', '/x/y/z/q/r/'];

describe('getBreadcrumbs', () => {
	test('matches the v2 implementation over random sites, pages and baseURLs', () => {
		const rng = createRng(20);
		let nonEmpty = 0;
		for (let i = 0; i < 3000; i++) {
			const pageList = randomPages(rng, 16);
			const page = pageList.length > 0 ? rng.pick(pageList) : randomPage(rng);
			const options = { baseURL: rng.pick(BASE_URLS) };
			const actual = outcome(() => getBreadcrumbs({ page, pageList }, options));
			const expected = outcome(() =>
				v2GetBreadcrumbs(
					{ page: toV2(page), pageList: pageList.map((p) => toV2(p)) },
					options,
				),
			);
			expect(actual, `case ${i}: ${page.filePathStem}`).toStrictEqual(expected);
			if ('value' in actual && actual.value.length > 0) nonEmpty++;
		}
		expect(nonEmpty).toBeGreaterThan(1000);
	});

	test('transformItem is applied after sorting, like v2', () => {
		const rng = createRng(21);
		const transformItem = (item: { href: string; title: string | undefined }) =>
			({ ...item, icon: item.href === '/' ? 'home' : 'page' }) as never;
		for (let i = 0; i < 300; i++) {
			const pageList = randomPages(rng, 12);
			const page = pageList.length > 0 ? rng.pick(pageList) : randomPage(rng);
			expect(getBreadcrumbs({ page, pageList }, { transformItem })).toStrictEqual(
				v2GetBreadcrumbs(
					{ page: toV2(page), pageList: pageList.map((p) => toV2(p)) },
					{ transformItem },
				),
			);
		}
	});

	test('lists the ancestors index pages and the page itself, with the meta object by reference', () => {
		const pageList: PageInfo[] = [
			{ url: '/', filePathStem: '/index', meta: { title: 'Home' } },
			{ url: '/a/', filePathStem: '/a/index', meta: { title: ' A ' } },
			{ url: '/a/b.html', filePathStem: '/a/b', meta: { title: '' } },
			{ url: '/c/', filePathStem: '/c/index', meta: { title: 'C' } },
		];
		const items = getBreadcrumbs({ page: pageList[2]!, pageList });
		expect(items).toStrictEqual([
			{ title: 'Home', href: '/', depth: 0, meta: pageList[0]!.meta },
			{ title: 'A', href: '/a/', depth: 1, meta: pageList[1]!.meta },
			{ title: '__NO_TITLE__', href: '/a/b.html', depth: 2, meta: pageList[2]!.meta },
		]);
		expect(items[0]!.meta).toBe(pageList[0]!.meta);
	});
});

describe('titleList', () => {
	test('matches the v2 implementation over random breadcrumbs and options', () => {
		const rng = createRng(22);
		const strings = [undefined, '', ' | ', ' - ', '  Site  ', 'Site', '📄 ', '/', '/a/'];
		for (let i = 0; i < 3000; i++) {
			const pageList = randomPages(rng, 12);
			const page = pageList.length > 0 ? rng.pick(pageList) : randomPage(rng);
			const breadcrumbs = getBreadcrumbs({ page, pageList });
			// Titles that are empty / undefined exercise the `!= null` filter.
			const mutated = breadcrumbs.map((item) =>
				rng.chance(0.15) ? { ...item, title: rng.pick([undefined, '', '  ']) } : item,
			);
			const options = {
				separator: rng.pick(strings),
				baseURL: rng.pick(strings),
				prefix: rng.pick(strings),
				suffix: rng.pick(strings),
				siteName: rng.pick(strings),
				fallback: rng.pick(strings),
			};
			const given = rng.chance(0.1) ? undefined : options;
			expect(titleList(mutated, given), `case ${i}`).toBe(v2TitleList(mutated, given));
		}
	});

	test('joins deepest first, excludes the root, and falls back to the site name', () => {
		const crumbs = [
			{ title: 'Home', href: '/', depth: 0, meta: {} },
			{ title: 'A', href: '/a/', depth: 1, meta: {} },
			{ title: 'B', href: '/a/b.html', depth: 2, meta: {} },
		];
		expect(titleList(crumbs, { siteName: ' S ' })).toBe('B | AS');
		expect(titleList(crumbs.slice(0, 1), { siteName: 'S', prefix: ' > ' })).toBe('>SS');
		expect(titleList([])).toBe('');
	});
});
