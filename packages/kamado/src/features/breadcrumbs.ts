import type { CompilableFile } from '../files/types.js';

import path from 'node:path';

import { getTitle } from './title.js';

export type BreadcrumbItem = {
	readonly title: string | undefined;
	readonly href: string;
	readonly depth: number;
};

export type GetBreadcrumbsOptions = {
	readonly baseURL?: string;
	readonly optimizeTitle?: (title: string) => string;
};

/**
 *
 * @param page
 * @param allPages
 * @param options
 */
export async function getBreadcrumbs(
	page: CompilableFile,
	allPages: readonly CompilableFile[],
	options?: GetBreadcrumbsOptions,
): Promise<BreadcrumbItem[]> {
	const baseURL = options?.baseURL ?? '/';
	const optimizeTitle = options?.optimizeTitle;
	const baseDepth = baseURL.split('/').filter(Boolean).length;
	const pages = allPages.filter((item) =>
		isAncestor(page.filePathStem, item.filePathStem),
	);
	const breadcrumbs = await Promise.all(
		pages.map(async (item) => ({
			title: await getTitle(item, optimizeTitle),
			href: item.url,
			depth: item.url.split('/').filter(Boolean).length,
		})),
	);

	return breadcrumbs
		.filter((item) => item.depth >= baseDepth)
		.sort((a, b) => a.depth - b.depth);
}

/**
 *
 * @param basePagePathStem
 * @param targetPathStem
 */
function isAncestor(basePagePathStem: string, targetPathStem: string) {
	const dirname = path.dirname(targetPathStem);
	const name = path.basename(targetPathStem);
	const included = dirname === '/' || basePagePathStem.startsWith(dirname + '/');
	const isIndex = name === 'index';
	const isSelf = basePagePathStem === targetPathStem;
	return (included && isIndex) || isSelf;
}
