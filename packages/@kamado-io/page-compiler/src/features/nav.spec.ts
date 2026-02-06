import type { PageData } from 'kamado/files';

import { describe, test, expect } from 'vitest';

import { getNavTree, type NavNode } from './nav.js';

/**
 * Creates a mock PageData for testing
 * The filePathStem is derived from URL to match directory structure:
 * - `/` → `/index`
 * - `/about/` → `/about/index`
 * @param url - URL path ending with `/`
 * @param title - Page title
 */
function createMockPage(url: string, title: string): PageData {
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
		metaData: { title },
	};
}

/**
 * Recursively counts all nodes in a tree
 * @param node
 */
function countNodes(node: NavNode | null | undefined): number {
	if (!node) return 0;
	return 1 + node.children.reduce((sum, child) => sum + countNodes(child as NavNode), 0);
}

/**
 * Recursively finds a node by URL in the tree
 * @param node
 * @param url
 */
function findNodeByUrl(node: NavNode | null | undefined, url: string): NavNode | null {
	if (!node) return null;
	if (node.url === url) return node;
	for (const child of node.children) {
		const found = findNodeByUrl(child, url);
		if (found) return found;
	}
	return null;
}

describe('getNavTree', () => {
	/**
	 * Level structure (depth in parentheses):
	 * / (depth 0) - level 1
	 * /about/ (depth 1) - level 2
	 * /about/history/ (depth 2) - level 3
	 * /about/history/2025/ (depth 3) - level 4
	 *
	 * getNavTree default behavior (without baseDepth option):
	 * - Returns the ancestor node at (current page's depth - 1)
	 * - For /about/history/2025/ (depth 3), returns /about/history/ (depth 2)
	 * - Can be customized with baseDepth option
	 */

	describe('basic functionality', () => {
		test('should return nav tree', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const aboutHistoryPage = createMockPage('/about/history/', 'History');
			const aboutHistory2025Page = createMockPage('/about/history/2025/', '2025');
			const pageList = [indexPage, aboutPage, aboutHistoryPage, aboutHistory2025Page];

			// Current page is /about/history/2025/ (depth 3, level 4)
			// getNavTree returns the depth 2 (level 3) ancestor: /about/history/
			const navTree = getNavTree({ currentPage: aboutHistory2025Page, pages: pageList });

			expect(navTree).not.toBeNull();
			expect(navTree?.url).toBe('/about/history/');
			expect(navTree?.meta?.title).toBe('History');
		});

		test('should include children in the returned tree', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const aboutHistoryPage = createMockPage('/about/history/', 'History');
			const aboutHistory2025Page = createMockPage('/about/history/2025/', '2025');
			const aboutHistory2024Page = createMockPage('/about/history/2024/', '2024');
			const pageList = [
				indexPage,
				aboutPage,
				aboutHistoryPage,
				aboutHistory2025Page,
				aboutHistory2024Page,
			];

			const navTree = getNavTree({ currentPage: aboutHistory2025Page, pages: pageList });

			expect(navTree).not.toBeNull();
			expect(navTree?.children).toHaveLength(2);
			expect(navTree?.children.map((c) => c.url).toSorted()).toEqual([
				'/about/history/2024/',
				'/about/history/2025/',
			]);
		});

		test('should return the page itself when at depth 2 with baseDepth option', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const aboutHistoryPage = createMockPage('/about/history/', 'History');
			const pageList = [indexPage, aboutPage, aboutHistoryPage];

			// Current page is /about/history/ (level 3, depth 1)
			const navTree = getNavTree(
				{ currentPage: aboutHistoryPage, pages: pageList },
				{
					baseDepth: 1,
				},
			);

			expect(navTree).not.toBeNull();
			expect(navTree?.url).toBe('/about/');
		});
	});

	describe('transformNode option', () => {
		test('should apply transformNode synchronously', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const aboutHistoryPage = createMockPage('/about/history/', 'History');
			const aboutHistory2025Page = createMockPage('/about/history/2025/', '2025');
			const pageList = [indexPage, aboutPage, aboutHistoryPage, aboutHistory2025Page];

			const badgeMap: Record<string, string> = {
				'/about/history/': 'section',
				'/about/history/2025/': 'new',
			};

			const navTree = getNavTree(
				{ currentPage: aboutHistory2025Page, pages: pageList },
				{
					transformNode: (node) => ({
						...node,
						badge: badgeMap[node.url] ?? 'default',
					}),
				},
			);

			expect(navTree).not.toBeNull();
			expect(navTree?.url).toBe('/about/history/');
			expect(navTree?.badge).toBe('section');

			// Check children nodes are also transformed
			const child2025 = navTree?.children.find((c) => c.url === '/about/history/2025/');
			expect(child2025).toBeDefined();
			expect(child2025?.badge).toBe('new');
		});

		test('should apply transformNode asynchronously with page.get()', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const aboutHistoryPage = createMockPage('/about/history/', 'History');
			const aboutHistory2025Page = createMockPage('/about/history/2025/', '2025');
			const pageList = [indexPage, aboutPage, aboutHistoryPage, aboutHistory2025Page];

			const navTree = getNavTree(
				{ currentPage: aboutHistory2025Page, pages: pageList },
				{
					transformNode: (node) => {
						return {
							...node,
							badge: 'new',
						};
					},
				},
			);

			expect(navTree).not.toBeNull();
			expect(navTree?.badge).toBe('new');

			const child2025 = navTree?.children.find((c) => c.url === '/about/history/2025/');
			expect(child2025?.badge).toBe('new');
		});

		test('should transform all nodes recursively in deep hierarchy', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const historyPage = createMockPage('/about/history/', 'History');
			const y2025Page = createMockPage('/about/history/2025/', '2025');
			const janPage = createMockPage('/about/history/2025/jan/', 'January');
			const pageList = [indexPage, aboutPage, historyPage, y2025Page, janPage];

			let transformCount = 0;
			const navTree = getNavTree(
				{ currentPage: janPage, pages: pageList },
				{
					transformNode: (node) => {
						transformCount++;
						return { ...node, transformed: true };
					},
				},
			);

			expect(navTree).not.toBeNull();
			// All nodes in the subtree should be transformed
			const totalNodes = countNodes(navTree);
			expect(transformCount).toBe(totalNodes);

			// Verify deep child is transformed
			const janNode = findNodeByUrl(navTree, '/about/history/2025/jan/');
			expect(janNode).not.toBeNull();
			expect(janNode?.transformed).toBe(true);
		});

		test('should propagate error from transformNode', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const historyPage = createMockPage('/about/history/', 'History');
			const pageList = [indexPage, aboutPage, historyPage];

			expect(() =>
				getNavTree(
					{ currentPage: historyPage, pages: pageList },
					{
						transformNode: () => {
							throw new Error('Transform error');
						},
					},
				),
			).toThrow('Transform error');
		});
	});

	describe('backward compatibility', () => {
		test('should work without transformNode', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const aboutHistoryPage = createMockPage('/about/history/', 'History');
			const pageList = [indexPage, aboutPage, aboutHistoryPage];

			const navTree = getNavTree(
				{ currentPage: aboutHistoryPage, pages: pageList },
				{
					baseDepth: 1,
				},
			);

			expect(navTree).not.toBeNull();
			expect(navTree?.meta?.title).toBe('About');
			expect(navTree?.url).toBe('/about/');
		});

		test('should work with empty options object', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const historyPage = createMockPage('/about/history/', 'History');
			const pageList = [indexPage, aboutPage, historyPage];

			const navTree = getNavTree({ currentPage: historyPage, pages: pageList });

			expect(navTree).not.toBeNull();
			expect(navTree?.url).toBe('/about/');
		});
	});

	describe('edge cases', () => {
		test('should handle single page at level 3', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const historyPage = createMockPage('/about/history/', 'History');
			const pageList = [indexPage, aboutPage, historyPage];

			expect(
				getNavTree(
					{ currentPage: historyPage, pages: pageList },
					{
						baseDepth: 2,
					},
				)?.url,
			).toBeUndefined();

			expect(
				getNavTree(
					{ currentPage: historyPage, pages: pageList },
					{
						baseDepth: 1,
					},
				)?.url,
			).toBe('/about/');

			expect(
				getNavTree(
					{ currentPage: historyPage, pages: pageList },
					{
						baseDepth: 0,
					},
				)?.url,
			).toBe('/');
		});
	});

	describe('removed nodes', () => {
		test('should remove nodes when transformNode returns null', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const historyPage = createMockPage('/about/history/', 'History');
			const pageList = [indexPage, aboutPage, historyPage];

			const navTree = getNavTree(
				{ currentPage: indexPage, pages: pageList },
				{
					transformNode: (node) => {
						if (node.url === '/about/') {
							return null;
						}
						return node;
					},
				},
			);

			expect(navTree).toStrictEqual({
				children: [],
				current: true,
				depth: 0,
				isAncestor: false,
				stem: '/',
				meta: {
					title: 'Home',
				},
				url: '/',
			});
		});

		test('should remove nodes when transformNode returns undefined', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const historyPage = createMockPage('/about/history/', 'History');
			const pageList = [indexPage, aboutPage, historyPage];

			const navTree = getNavTree(
				{ currentPage: indexPage, pages: pageList },
				{
					transformNode: (node) => {
						if (node.url === '/about/') {
							return;
						}
						return node;
					},
				},
			);

			expect(navTree).toStrictEqual({
				children: [],
				current: true,
				depth: 0,
				isAncestor: false,
				stem: '/',
				meta: {
					title: 'Home',
				},
				url: '/',
			});
		});

		test('should remove parent node and all its descendants when parent returns null', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const historyPage = createMockPage('/about/history/', 'History');
			const history2025Page = createMockPage('/about/history/2025/', '2025');
			const history2025JanPage = createMockPage('/about/history/2025/jan/', 'January');
			const contactPage = createMockPage('/contact/', 'Contact');
			const pageList = [
				indexPage,
				aboutPage,
				historyPage,
				history2025Page,
				history2025JanPage,
				contactPage,
			];

			const navTree = getNavTree(
				{ currentPage: indexPage, pages: pageList },
				{
					transformNode: (node) => {
						// Remove /about/ and all its descendants should disappear
						if (node.url === '/about/') {
							return null;
						}
						return node;
					},
				},
			);

			expect(navTree).not.toBeNull();
			expect(navTree?.url).toBe('/');
			expect(navTree?.children).toHaveLength(1);
			expect(navTree?.children[0]?.url).toBe('/contact/');

			// Verify that all /about/ descendants are gone from the entire tree
			expect(findNodeByUrl(navTree, '/about/')).toBeNull();
			expect(findNodeByUrl(navTree, '/about/history/')).toBeNull();
			expect(findNodeByUrl(navTree, '/about/history/2025/')).toBeNull();
			expect(findNodeByUrl(navTree, '/about/history/2025/jan/')).toBeNull();
		});

		test('should not call transformNode for descendants when parent returns null', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const historyPage = createMockPage('/about/history/', 'History');
			const history2025Page = createMockPage('/about/history/2025/', '2025');
			const pageList = [indexPage, aboutPage, historyPage, history2025Page];

			const calledUrls: string[] = [];

			getNavTree(
				{ currentPage: indexPage, pages: pageList },
				{
					transformNode: (node) => {
						calledUrls.push(node.url);
						if (node.url === '/about/') {
							return null;
						}
						return node;
					},
				},
			);

			// transformNode is called bottom-up (children first, then parent)
			// When /about/ returns null, its children have already been processed
			// but the entire subtree is removed from the result
			expect(calledUrls).toContain('/');
			expect(calledUrls).toContain('/about/');
			// Children are processed before parent
			expect(calledUrls).toContain('/about/history/');
			expect(calledUrls).toContain('/about/history/2025/');
		});

		test('should remove child nodes from parent when transformNode returns null', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const aboutHistoryPage = createMockPage('/about/history/', 'History');
			const aboutHistory2025Page = createMockPage('/about/history/2025/', '2025');
			const aboutHistory2024Page = createMockPage('/about/history/2024/', '2024');
			const pageList = [
				indexPage,
				aboutPage,
				aboutHistoryPage,
				aboutHistory2025Page,
				aboutHistory2024Page,
			];

			const navTree = getNavTree(
				{ currentPage: aboutHistory2025Page, pages: pageList },
				{
					transformNode: (node) => {
						if (node.url === '/about/history/2024/') {
							return null;
						}
						return node;
					},
				},
			);

			expect(navTree).not.toBeNull();
			expect(navTree?.url).toBe('/about/history/');
			expect(navTree?.children).toHaveLength(1);
			expect(navTree?.children[0]?.url).toBe('/about/history/2025/');
			// Verify removed node is not findable anywhere
			expect(findNodeByUrl(navTree, '/about/history/2024/')).toBeNull();
		});

		test('should remove multiple child nodes when transformNode returns null or undefined', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const aboutHistoryPage = createMockPage('/about/history/', 'History');
			const aboutHistory2025Page = createMockPage('/about/history/2025/', '2025');
			const aboutHistory2024Page = createMockPage('/about/history/2024/', '2024');
			const aboutHistory2023Page = createMockPage('/about/history/2023/', '2023');
			const pageList = [
				indexPage,
				aboutPage,
				aboutHistoryPage,
				aboutHistory2025Page,
				aboutHistory2024Page,
				aboutHistory2023Page,
			];

			const navTree = getNavTree(
				{ currentPage: aboutHistory2025Page, pages: pageList },
				{
					transformNode: (node) => {
						if (node.url === '/about/history/2024/') {
							return null;
						}
						if (node.url === '/about/history/2023/') {
							return;
						}
						return node;
					},
				},
			);

			expect(navTree).not.toBeNull();
			expect(navTree?.url).toBe('/about/history/');
			expect(navTree?.children).toHaveLength(1);
			expect(navTree?.children[0]?.url).toBe('/about/history/2025/');
			// Both removed nodes should not exist anywhere
			expect(findNodeByUrl(navTree, '/about/history/2024/')).toBeNull();
			expect(findNodeByUrl(navTree, '/about/history/2023/')).toBeNull();
		});

		test('should result in empty children when all child nodes are removed', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const historyPage = createMockPage('/about/history/', 'History');
			const teamPage = createMockPage('/about/team/', 'Team');
			const pageList = [indexPage, aboutPage, historyPage, teamPage];

			const navTree = getNavTree(
				{ currentPage: indexPage, pages: pageList },
				{
					transformNode: (node) => {
						// Remove all children of /about/
						if (node.url === '/about/history/' || node.url === '/about/team/') {
							return null;
						}
						return node;
					},
				},
			);

			expect(navTree).not.toBeNull();
			const aboutNode = findNodeByUrl(navTree, '/about/');
			expect(aboutNode).not.toBeNull();
			expect(aboutNode?.children).toHaveLength(0);
			expect(aboutNode?.children).toStrictEqual([]);
		});

		test('should not affect sibling nodes when one sibling is removed', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const contactPage = createMockPage('/contact/', 'Contact');
			const servicesPage = createMockPage('/services/', 'Services');
			const pageList = [indexPage, aboutPage, contactPage, servicesPage];

			const navTree = getNavTree(
				{ currentPage: indexPage, pages: pageList },
				{
					transformNode: (node) => {
						if (node.url === '/contact/') {
							return null;
						}
						return node;
					},
				},
			);

			expect(navTree).not.toBeNull();
			expect(navTree?.children).toHaveLength(2);
			const urls = navTree?.children.map((c) => c.url).toSorted();
			expect(urls).toEqual(['/about/', '/services/']);
			// Verify each sibling still has correct properties
			const aboutNode = findNodeByUrl(navTree, '/about/');
			const servicesNode = findNodeByUrl(navTree, '/services/');
			expect(aboutNode?.meta?.title).toBe('About');
			expect(servicesNode?.meta?.title).toBe('Services');
		});

		test('should remove grandchild while keeping parent and child intact', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const historyPage = createMockPage('/about/history/', 'History');
			const history2025Page = createMockPage('/about/history/2025/', '2025');
			const history2024Page = createMockPage('/about/history/2024/', '2024');
			const pageList = [
				indexPage,
				aboutPage,
				historyPage,
				history2025Page,
				history2024Page,
			];

			const navTree = getNavTree(
				{ currentPage: history2025Page, pages: pageList },
				{
					transformNode: (node) => {
						// Remove only a grandchild (2024)
						if (node.url === '/about/history/2024/') {
							return null;
						}
						return node;
					},
				},
			);

			expect(navTree).not.toBeNull();
			// Parent (/about/history/) should exist
			expect(navTree?.url).toBe('/about/history/');
			expect(navTree?.meta?.title).toBe('History');
			// Only one child should remain
			expect(navTree?.children).toHaveLength(1);
			expect(navTree?.children[0]?.url).toBe('/about/history/2025/');
			// Grandchild should be gone
			expect(findNodeByUrl(navTree, '/about/history/2024/')).toBeNull();
		});

		test('should return null when root node is removed by transformNode', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const historyPage = createMockPage('/about/history/', 'History');
			const pageList = [indexPage, aboutPage, historyPage];

			const navTree = getNavTree(
				{ currentPage: indexPage, pages: pageList },
				{
					transformNode: () => null,
				},
			);

			expect(navTree).toBeNull();
		});

		test('should return undefined when root node is removed by transformNode returning undefined', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const historyPage = createMockPage('/about/history/', 'History');
			const pageList = [indexPage, aboutPage, historyPage];

			const navTree = getNavTree(
				{ currentPage: indexPage, pages: pageList },
				{
					// @ts-ignore
					transformNode: () => {},
				},
			);

			expect(navTree).toBeUndefined();
		});

		test('should preserve order of remaining siblings after removal', () => {
			const indexPage = createMockPage('/', 'Home');
			const aPage = createMockPage('/a/', 'A');
			const bPage = createMockPage('/b/', 'B');
			const cPage = createMockPage('/c/', 'C');
			const dPage = createMockPage('/d/', 'D');
			const pageList = [indexPage, aPage, bPage, cPage, dPage];

			const navTree = getNavTree(
				{ currentPage: indexPage, pages: pageList },
				{
					transformNode: (node) => {
						// Remove B and D
						if (node.url === '/b/' || node.url === '/d/') {
							return null;
						}
						return node;
					},
				},
			);

			expect(navTree).not.toBeNull();
			expect(navTree?.children).toHaveLength(2);
			// Order should be preserved: A, C (B and D removed)
			expect(navTree?.children[0]?.url).toBe('/a/');
			expect(navTree?.children[1]?.url).toBe('/c/');
		});

		test('should produce exact tree structure when parent with descendants is removed (toStrictEqual)', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const historyPage = createMockPage('/about/history/', 'History');
			const history2025Page = createMockPage('/about/history/2025/', '2025');
			const contactPage = createMockPage('/contact/', 'Contact');
			const pageList = [indexPage, aboutPage, historyPage, history2025Page, contactPage];

			const navTree = getNavTree(
				{ currentPage: indexPage, pages: pageList },
				{
					baseDepth: 0,
					transformNode: (node) => {
						if (node.url === '/about/') {
							return null;
						}
						return node;
					},
				},
			);

			// Verify exact tree structure after removal
			expect(navTree).toStrictEqual({
				url: '/',
				stem: '/',
				depth: 0,
				current: true,
				isAncestor: false,
				meta: {
					title: 'Home',
				},
				children: [
					{
						url: '/contact/',
						stem: '/contact/',
						depth: 1,
						current: false,
						isAncestor: false,
						meta: {
							title: 'Contact',
						},
						children: [],
					},
				],
			});
		});

		test('should produce exact tree structure when child is removed but siblings remain (toStrictEqual)', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const contactPage = createMockPage('/contact/', 'Contact');
			const servicesPage = createMockPage('/services/', 'Services');
			const pageList = [indexPage, aboutPage, contactPage, servicesPage];

			const navTree = getNavTree(
				{ currentPage: indexPage, pages: pageList },
				{
					baseDepth: 0,
					transformNode: (node) => {
						if (node.url === '/contact/') {
							return null;
						}
						return node;
					},
				},
			);

			expect(navTree).toStrictEqual({
				url: '/',
				stem: '/',
				depth: 0,
				current: true,
				isAncestor: false,
				meta: {
					title: 'Home',
				},
				children: [
					{
						url: '/about/',
						stem: '/about/',
						depth: 1,
						current: false,
						isAncestor: false,
						meta: {
							title: 'About',
						},
						children: [],
					},
					{
						url: '/services/',
						stem: '/services/',
						depth: 1,
						current: false,
						isAncestor: false,
						meta: {
							title: 'Services',
						},
						children: [],
					},
				],
			});
		});

		test('should produce exact tree structure when grandchild is removed (toStrictEqual)', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const historyPage = createMockPage('/about/history/', 'History');
			const history2025Page = createMockPage('/about/history/2025/', '2025');
			const history2024Page = createMockPage('/about/history/2024/', '2024');
			const pageList = [
				indexPage,
				aboutPage,
				historyPage,
				history2025Page,
				history2024Page,
			];

			const navTree = getNavTree(
				{ currentPage: history2025Page, pages: pageList },
				{
					baseDepth: 2,
					transformNode: (node) => {
						if (node.url === '/about/history/2024/') {
							return null;
						}
						return node;
					},
				},
			);

			expect(navTree).toStrictEqual({
				url: '/about/history/',
				stem: '/about/history/',
				depth: 2,
				current: false,
				isAncestor: true,
				meta: {
					title: 'History',
				},
				children: [
					{
						url: '/about/history/2025/',
						stem: '/about/history/2025/',
						depth: 3,
						current: true,
						isAncestor: false,
						meta: {
							title: '2025',
						},
						children: [],
					},
				],
			});
		});

		test('should produce exact tree structure when multiple children are removed via null and undefined (toStrictEqual)', () => {
			const indexPage = createMockPage('/', 'Home');
			const aPage = createMockPage('/a/', 'A');
			const bPage = createMockPage('/b/', 'B');
			const cPage = createMockPage('/c/', 'C');
			const dPage = createMockPage('/d/', 'D');
			const ePage = createMockPage('/e/', 'E');
			const pageList = [indexPage, aPage, bPage, cPage, dPage, ePage];

			const navTree = getNavTree(
				{ currentPage: indexPage, pages: pageList },
				{
					baseDepth: 0,
					transformNode: (node) => {
						if (node.url === '/b/') return null;
						if (node.url === '/d/') return;
						return node;
					},
				},
			);

			expect(navTree).toStrictEqual({
				url: '/',
				stem: '/',
				depth: 0,
				current: true,
				isAncestor: false,
				meta: {
					title: 'Home',
				},
				children: [
					{
						url: '/a/',
						stem: '/a/',
						depth: 1,
						current: false,
						isAncestor: false,
						meta: {
							title: 'A',
						},
						children: [],
					},
					{
						url: '/c/',
						stem: '/c/',
						depth: 1,
						current: false,
						isAncestor: false,
						meta: {
							title: 'C',
						},
						children: [],
					},
					{
						url: '/e/',
						stem: '/e/',
						depth: 1,
						current: false,
						isAncestor: false,
						meta: {
							title: 'E',
						},
						children: [],
					},
				],
			});
		});

		test('should produce exact tree structure with deep hierarchy after removal (toStrictEqual)', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const historyPage = createMockPage('/about/history/', 'History');
			const history2025Page = createMockPage('/about/history/2025/', '2025');
			const janPage = createMockPage('/about/history/2025/jan/', 'January');
			const febPage = createMockPage('/about/history/2025/feb/', 'February');
			const pageList = [
				indexPage,
				aboutPage,
				historyPage,
				history2025Page,
				janPage,
				febPage,
			];

			const navTree = getNavTree(
				{ currentPage: janPage, pages: pageList },
				{
					baseDepth: 2,
					transformNode: (node) => {
						if (node.url === '/about/history/2025/feb/') {
							return null;
						}
						return node;
					},
				},
			);

			expect(navTree).toStrictEqual({
				url: '/about/history/',
				stem: '/about/history/',
				depth: 2,
				current: false,
				isAncestor: true,
				meta: {
					title: 'History',
				},
				children: [
					{
						url: '/about/history/2025/',
						stem: '/about/history/2025/',
						depth: 3,
						current: false,
						isAncestor: true,
						meta: {
							title: '2025',
						},
						children: [
							{
								url: '/about/history/2025/jan/',
								stem: '/about/history/2025/jan/',
								depth: 4,
								current: true,
								isAncestor: false,
								meta: {
									title: 'January',
								},
								children: [],
							},
						],
					},
				],
			});
		});

		test('should produce empty children array when all descendants are removed (toStrictEqual)', () => {
			const indexPage = createMockPage('/', 'Home');
			const aboutPage = createMockPage('/about/', 'About');
			const historyPage = createMockPage('/about/history/', 'History');
			const teamPage = createMockPage('/about/team/', 'Team');
			const pageList = [indexPage, aboutPage, historyPage, teamPage];

			const navTree = getNavTree(
				{ currentPage: indexPage, pages: pageList },
				{
					baseDepth: 0,
					transformNode: (node) => {
						if (node.url === '/about/history/' || node.url === '/about/team/') {
							return null;
						}
						return node;
					},
				},
			);

			expect(navTree).toStrictEqual({
				url: '/',
				stem: '/',
				depth: 0,
				current: true,
				isAncestor: false,
				meta: {
					title: 'Home',
				},
				children: [
					{
						url: '/about/',
						stem: '/about/',
						depth: 1,
						current: false,
						isAncestor: false,
						meta: {
							title: 'About',
						},
						children: [],
					},
				],
			});
		});
	});
});
