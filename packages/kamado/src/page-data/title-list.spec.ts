import type { BreadcrumbItem } from './breadcrumbs.js';

import { describe, expect, test } from 'vitest';

import { titleList } from './title-list.js';

/**
 * Builds a breadcrumb item for the fixtures.
 * @param href - Link URL.
 * @param title - Title; omit it for a page without one.
 * @returns The breadcrumb item.
 */
function item(href: string, title?: string): BreadcrumbItem {
	return { href, title, depth: href.split('/').filter(Boolean).length, meta: {} };
}

const top = [item('/', 'Top')];
const deep = [
	item('/', 'Top'),
	item('/section/', 'Section'),
	item('/section/page/', 'Page Title'),
];

describe('titleList', () => {
	test('トップページは titles から除かれ、fallback と suffix の siteName が区切りなしで続く', () => {
		expect(titleList(top, { siteName: 'SITE' })).toBe('SITESITE');
	});

	test('トップページでも suffix を空にすれば siteName は 1 回だけ', () => {
		expect(titleList(top, { siteName: 'SITE', suffix: '' })).toBe('SITE');
	});

	test('トップページは fallback を指定すればその文字列になる', () => {
		expect(titleList(top, { siteName: 'SITE', fallback: 'Home', suffix: '' })).toBe(
			'Home',
		);
	});

	test('fallback を空にすると、トップページは suffix だけになる', () => {
		expect(titleList(top, { siteName: 'SITE', fallback: '' })).toBe('SITE');
	});

	test('深い階層はトップを除いて深い順に区切り、suffix が区切りなしで続く', () => {
		expect(titleList(deep, { siteName: 'SITE' })).toBe('Page Title | SectionSITE');
	});

	test('separator で区切りを変えられる', () => {
		expect(titleList(deep, { siteName: 'SITE', separator: ' - ' })).toBe(
			'Page Title - SectionSITE',
		);
	});

	test('suffix は trim されるので、区切りは suffix に書いても効かない', () => {
		expect(titleList(deep, { siteName: 'SITE', suffix: ' | SITE' })).toBe(
			'Page Title | Section| SITE',
		);
	});

	test('prefix は trim されて先頭に付く', () => {
		expect(titleList(deep, { siteName: 'SITE', prefix: '📄 ' })).toBe(
			'📄Page Title | SectionSITE',
		);
	});

	test('タイトルがないページは飛ばされる', () => {
		expect(
			titleList(
				[item('/', 'Top'), item('/section/'), item('/section/page/', 'Page Title')],
				{
					siteName: 'SITE',
				},
			),
		).toBe('Page TitleSITE');
	});

	test('baseURL と一致するページも除かれる', () => {
		expect(
			titleList([item('/en/', 'English')], {
				baseURL: '/en/',
				siteName: 'SITE',
				suffix: '',
			}),
		).toBe('SITE');
	});
});
