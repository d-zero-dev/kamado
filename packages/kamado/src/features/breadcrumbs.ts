import type { CompilableFile } from '../files/types.js';

import path from 'node:path';

import { getTitle } from './title.js';

/**
 * Breadcrumb item
 */
export type BreadcrumbItem = {
	/**
	 * Title
	 */
	readonly title: string | undefined;
	/**
	 * Link URL
	 */
	readonly href: string;
	/**
	 * Hierarchy depth
	 */
	readonly depth: number;
};

/**
 * Options for getting breadcrumbs
 */
export type GetBreadcrumbsOptions = {
	/**
	 * Base URL
	 * @default '/'
	 */
	readonly baseURL?: string;
	/**
	 * Function to optimize titles
	 */
	readonly optimizeTitle?: (title: string) => string;
};

/**
 * Gets breadcrumb list for a page
 * @param page - Target page file
 * @param pageList - List of all page files
 * @param options - Options for getting breadcrumbs
 * @returns Array of breadcrumb items
 * @example
 * ```typescript
 * const breadcrumbs = await getBreadcrumbs(currentPage, pageList, {
 *   baseURL: '/',
 *   optimizeTitle: (title) => title.trim(),
 * });
 * ```
 */
export async function getBreadcrumbs(
	page: CompilableFile & { title?: string },
	pageList: readonly (CompilableFile & { title?: string })[],
	options?: GetBreadcrumbsOptions,
): Promise<BreadcrumbItem[]> {
	const baseURL = options?.baseURL ?? '/';
	const optimizeTitle = options?.optimizeTitle;
	const baseDepth = baseURL.split('/').filter(Boolean).length;
	const pages = pageList.filter((item) =>
		isAncestor(page.filePathStem, item.filePathStem),
	);
	const breadcrumbs = await Promise.all(
		pages.map(async (item) => ({
			title:
				item.title?.trim() ||
				(await getTitle(item, optimizeTitle, true)) ||
				'__NO_TITLE__',
			href: item.url,
			depth: item.url.split('/').filter(Boolean).length,
		})),
	);

	return breadcrumbs
		.filter((item) => item.depth >= baseDepth)
		.toSorted((a, b) => a.depth - b.depth);
}

/**
 * Checks if target path is an ancestor of base path
 * @param basePagePathStem - Base page path stem
 * @param targetPathStem - Target path stem to check
 * @returns True if target is an ancestor (index file) or the same path
 */
function isAncestor(basePagePathStem: string, targetPathStem: string) {
	const dirname = path.dirname(targetPathStem);
	const name = path.basename(targetPathStem);
	const included = dirname === '/' || basePagePathStem.startsWith(dirname + '/');
	const isIndex = name === 'index';
	const isSelf = basePagePathStem === targetPathStem;
	return (included && isIndex) || isSelf;
}
