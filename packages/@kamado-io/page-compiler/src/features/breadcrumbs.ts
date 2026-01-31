import type { CompilableFile } from 'kamado/files';

import path from 'node:path';

import { getTitle } from './get-title.js';

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
 * @template TOut - Type of additional properties added by transformItem
 */
export type GetBreadcrumbsOptions<
	TOut extends Record<string, unknown> = Record<never, never>,
> = {
	/**
	 * Base URL
	 * @default '/'
	 */
	readonly baseURL?: string;
	/**
	 * Function to optimize titles
	 */
	readonly optimizeTitle?: (title: string) => string;
	/**
	 * Transform each breadcrumb item
	 * @param item - Original breadcrumb item
	 * @returns Transformed breadcrumb item with additional properties
	 */
	readonly transformItem?: (item: BreadcrumbItem) => BreadcrumbItem & TOut;
};

/**
 * Gets breadcrumb list for a page
 * @template TOut - Type of additional properties added by transformItem
 * @param page - Target page file
 * @param pageList - List of all page files
 * @param options - Options for getting breadcrumbs
 * @returns Array of breadcrumb items (with additional properties if transformItem is specified)
 * @example
 * ```typescript
 * const breadcrumbs = getBreadcrumbs(currentPage, pageList, {
 *   baseURL: '/',
 *   optimizeTitle: (title) => title.trim(),
 * });
 * ```
 * @example
 * ```typescript
 * // With transformItem for adding custom properties
 * const breadcrumbs = getBreadcrumbs(currentPage, pageList, {
 *   transformItem: (item) => ({
 *     ...item,
 *     icon: item.href === '/' ? 'home' : 'page',
 *   }),
 * });
 * ```
 */
/**
 * Required context for breadcrumbs generation
 */
export interface GetBreadcrumbsContext {
	readonly page: CompilableFile & { title?: string };
	readonly pageList: readonly (CompilableFile & { title?: string })[];
}

/**
 *
 * @param context
 * @param options
 */
export function getBreadcrumbs<
	TOut extends Record<string, unknown> = Record<never, never>,
>(
	context: GetBreadcrumbsContext,
	options?: GetBreadcrumbsOptions<TOut>,
): (BreadcrumbItem & TOut)[] {
	const { page, pageList } = context;
	const baseURL = options?.baseURL ?? '/';
	const optimizeTitle = options?.optimizeTitle;
	const baseDepth = baseURL.split('/').filter(Boolean).length;
	const pages = pageList.filter((item) =>
		isAncestor(page.filePathStem, item.filePathStem),
	);
	const breadcrumbs = pages.map((sourcePage) => ({
		title:
			sourcePage.title?.trim() ||
			getTitle(sourcePage, { optimizeTitle, safe: true }) ||
			'__NO_TITLE__',
		href: sourcePage.url,
		depth: sourcePage.url.split('/').filter(Boolean).length,
	}));

	const filtered = breadcrumbs
		.filter((item) => item.depth >= baseDepth)
		.toSorted((a, b) => a.depth - b.depth);

	// Apply transformItem if specified
	if (options?.transformItem) {
		return filtered.map((item) => options.transformItem!(item as BreadcrumbItem));
	}

	return filtered as (BreadcrumbItem & TOut)[];
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
