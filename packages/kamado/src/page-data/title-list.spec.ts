import { describe, expect, test } from 'vitest';

import { titleList } from './title-list.js';

const top = [{ href: '/', title: 'Top' }];
const deep = [
	{ href: '/', title: 'Top' },
	{ href: '/section/', title: 'Section' },
	{ href: '/section/page/', title: 'Page Title' },
];

describe('titleList', () => {
	test('トップページは titles から除かれ、fallback と suffix の siteName が区切りなしで続く', () => {
		expect(titleList(top, { siteName: 'SITE' })).toBe('SITESITE');
	});

	test('トップページでも suffix を空にすれば siteName は 1 回だけ', () => {
		expect(titleList(top, { siteName: 'SITE', suffix: '' })).toBe('SITE');
	});

	test('深い階層はトップを除いて深い順に区切り、suffix が区切りなしで続く', () => {
		expect(titleList(deep, { siteName: 'SITE' })).toBe('Page Title | SectionSITE');
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

	test('baseURL と一致するページも除かれる', () => {
		expect(
			titleList([{ href: '/en/', title: 'English' }], {
				baseURL: '/en/',
				siteName: 'SITE',
				suffix: '',
			}),
		).toBe('SITE');
	});
});
