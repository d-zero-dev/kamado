import type { PageInfo } from './nav.js';

import path from 'node:path';

/**
 * Breadcrumb item.
 * @template M - Meta type of the pages.
 */
export type BreadcrumbItem<M extends Record<string, unknown> = Record<string, unknown>> =
	{
		/** Title (`__NO_TITLE__` when the page has none). */
		readonly title: string | undefined;
		/** Link URL. */
		readonly href: string;
		/** Hierarchy depth. */
		readonly depth: number;
		/** The source page's meta object itself (not a copy). */
		readonly meta: M;
	};

/**
 * Options for {@link getBreadcrumbs}.
 * @template M - Meta type of the pages.
 * @template TOut - Extra properties added by `transformItem`.
 */
export type GetBreadcrumbsOptions<
	M extends Record<string, unknown> = Record<string, unknown>,
	TOut extends Record<string, unknown> = Record<never, never>,
> = {
	/** Base URL; items shallower than it are dropped. Default `'/'`. */
	readonly baseURL?: string;
	/** Maps each item to one with extra properties. */
	readonly transformItem?: (item: BreadcrumbItem<M>) => BreadcrumbItem<M> & TOut;
};

/**
 * Context of {@link getBreadcrumbs}.
 */
export interface GetBreadcrumbsContext {
	/** The page being rendered. */
	readonly page: PageInfo;
	/** Every page of the site. */
	readonly pageList: readonly PageInfo[];
}

/**
 * Gets the breadcrumb list of a page: its own entry and the `index` pages of
 * its ancestor directories, ordered by depth.
 * @template M - Meta type of the pages.
 * @template TOut - Extra properties added by `transformItem`.
 * @param context - Current page and page list.
 * @param options - Breadcrumb options.
 * @returns The breadcrumb items.
 * @example
 * ```ts
 * const breadcrumbs = getBreadcrumbs({ page, pageList }, { baseURL: '/' });
 * // [{ title: 'Home', href: '/', depth: 0, meta }, ...]
 * ```
 */
export function getBreadcrumbs<
	M extends Record<string, unknown> = Record<string, unknown>,
	TOut extends Record<string, unknown> = Record<never, never>,
>(
	context: GetBreadcrumbsContext,
	options?: GetBreadcrumbsOptions<M, TOut>,
): (BreadcrumbItem<M> & TOut)[] {
	const { page, pageList } = context;
	const baseURL = options?.baseURL ?? '/';
	const baseDepth = baseURL.split('/').filter(Boolean).length;
	const pages = pageList.filter((item) =>
		isAncestor(page.filePathStem, item.filePathStem),
	);
	const breadcrumbs = pages.map((sourcePage) => ({
		title: (sourcePage.meta?.title as string | undefined)?.trim() || '__NO_TITLE__',
		href: sourcePage.url,
		depth: sourcePage.url.split('/').filter(Boolean).length,
		meta: sourcePage.meta as M,
	}));

	const filtered = breadcrumbs
		.filter((item) => item.depth >= baseDepth)
		.toSorted((a, b) => a.depth - b.depth);

	if (options?.transformItem) {
		return filtered.map((item) => options.transformItem!(item as BreadcrumbItem<M>));
	}
	return filtered as (BreadcrumbItem<M> & TOut)[];
}

/**
 * Whether the target is the base page itself or an `index` page of one of its
 * ancestor directories.
 * @param basePagePathStem - Base page stem.
 * @param targetPathStem - Stem to check.
 * @returns True for an ancestor index or the page itself.
 */
function isAncestor(basePagePathStem: string, targetPathStem: string): boolean {
	const dirname = path.dirname(targetPathStem);
	const name = path.basename(targetPathStem);
	const included = dirname === '/' || basePagePathStem.startsWith(dirname + '/');
	const isIndex = name === 'index';
	const isSelf = basePagePathStem === targetPathStem;
	return (included && isIndex) || isSelf;
}
