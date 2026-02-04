import type { CompilableFile } from 'kamado/files';

import { describe, test, expect } from 'vitest';

import { getBreadcrumbs } from './breadcrumbs.js';

/**
 * Creates a mock CompilableFile for testing
 * The filePathStem is derived from URL to match the isAncestor logic:
 * - `/` → `/index` (index file at root)
 * - `/about/` → `/about/index` (index file in about directory)
 * - `/about/team/` → `/about/team/index`
 * @param url - URL path ending with `/`
 * @param title - Page title
 */
function createMockPage(url: string, title: string): CompilableFile & { title: string } {
	// Convert URL to filePathStem matching isAncestor logic
	// /about/ → /about/index, / → /index
	const filePathStem = url === '/' ? '/index' : url.replace(/\/$/, '/index');
	const slug = url === '/' ? 'index' : url.split('/').findLast(Boolean) || 'index';

	return {
		inputPath: `/mock/input${filePathStem}.html`,
		outputPath: `/mock/output${filePathStem}.html`,
		fileSlug: slug,
		filePathStem,
		url,
		extension: '.html',
		date: new Date(),
		title,
	};
}

describe('getBreadcrumbs', () => {
	describe('basic functionality', () => {
		test('should return breadcrumbs', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const pageList = [indexPage, aboutPage];

			const breadcrumbs = getBreadcrumbs({ page: aboutPage, pageList });

			expect(breadcrumbs).toHaveLength(2);
			expect(breadcrumbs[0]?.title).toBe('Home');
			expect(breadcrumbs[0]?.href).toBe('/');
			expect(breadcrumbs[0]?.depth).toBe(0);
			expect(breadcrumbs[1]?.title).toBe('About');
			expect(breadcrumbs[1]?.href).toBe('/about/');
			expect(breadcrumbs[1]?.depth).toBe(1);
		});

		test('should handle deep hierarchy (3+ levels)', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const teamPage = createMockPage('/about/team/', 'Team');
			const memberPage = createMockPage('/about/team/member/', 'Member');
			const pageList = [indexPage, aboutPage, teamPage, memberPage];

			const breadcrumbs = getBreadcrumbs({ page: memberPage, pageList });

			expect(breadcrumbs).toHaveLength(4);
			expect(breadcrumbs.map((b) => b.href)).toEqual([
				'/',
				'/about/',
				'/about/team/',
				'/about/team/member/',
			]);
			expect(breadcrumbs.map((b) => b.depth)).toEqual([0, 1, 2, 3]);
		});

		test('should return sorted by depth', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const teamPage = createMockPage('/about/team/', 'Team');
			// Pass in shuffled order
			const pageList = [teamPage, indexPage, aboutPage];

			const breadcrumbs = getBreadcrumbs({ page: teamPage, pageList });

			expect(breadcrumbs.map((b) => b.href)).toEqual(['/', '/about/', '/about/team/']);
		});
	});

	describe('baseURL option', () => {
		test('should filter breadcrumbs by baseURL', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const teamPage = createMockPage('/about/team/', 'Team');
			const pageList = [indexPage, aboutPage, teamPage];

			const breadcrumbs = getBreadcrumbs(
				{ page: teamPage, pageList },
				{
					baseURL: '/about/',
				},
			);

			// Should exclude items with depth < 1 (baseURL depth)
			expect(breadcrumbs).toHaveLength(2);
			expect(breadcrumbs.map((b) => b.href)).toEqual(['/about/', '/about/team/']);
		});

		test('should handle root baseURL (default)', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const pageList = [indexPage, aboutPage];

			const breadcrumbs = getBreadcrumbs(
				{ page: aboutPage, pageList },
				{
					baseURL: '/',
				},
			);

			expect(breadcrumbs).toHaveLength(2);
		});
	});

	describe('transformItem option', () => {
		test('should apply transformItem to add custom properties', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const pageList = [indexPage, aboutPage];

			const iconMap: Record<string, string> = {
				'/': 'home-icon',
				'/about/': 'about-icon',
			};

			const breadcrumbs = getBreadcrumbs(
				{ page: aboutPage, pageList },
				{
					transformItem: (item) => ({
						...item,
						icon: iconMap[item.href] ?? 'default',
					}),
				},
			);

			expect(breadcrumbs).toHaveLength(2);
			expect(breadcrumbs[0]).toMatchObject({
				title: 'Home',
				href: '/',
				icon: 'home-icon',
			});
			expect(breadcrumbs[1]).toMatchObject({
				title: 'About',
				href: '/about/',
				icon: 'about-icon',
			});
		});

		test('should propagate error from transformItem', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const pageList = [indexPage, aboutPage];

			expect(() =>
				getBreadcrumbs(
					{ page: aboutPage, pageList },
					{
						transformItem: () => {
							throw new Error('Transform error');
						},
					},
				),
			).toThrow('Transform error');
		});
	});

	describe('edge cases', () => {
		test('should return only current page when it is the root', () => {
			const indexPage = createMockPage('/', 'Home');
			const pageList = [indexPage];

			const breadcrumbs = getBreadcrumbs({ page: indexPage, pageList });

			expect(breadcrumbs).toHaveLength(1);
			expect(breadcrumbs[0]?.href).toBe('/');
		});

		test('should return empty array when pageList is empty', () => {
			const aboutPage = createMockPage('/about/', 'About');
			const pageList: (CompilableFile & { title: string })[] = [];

			const breadcrumbs = getBreadcrumbs({ page: aboutPage, pageList });

			expect(breadcrumbs).toHaveLength(0);
		});

		test('should return only matching ancestors', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const contactPage = createMockPage('/contact/', 'Contact'); // Not an ancestor
			const teamPage = createMockPage('/about/team/', 'Team');
			const pageList = [indexPage, aboutPage, contactPage, teamPage];

			const breadcrumbs = getBreadcrumbs({ page: teamPage, pageList });

			// /contact/ should not be included
			expect(breadcrumbs.map((b) => b.href)).toEqual(['/', '/about/', '/about/team/']);
		});
	});
});
