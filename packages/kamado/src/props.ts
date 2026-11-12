/**
 * What a page or layout component receives as `props` (RFC section 7.3):
 * `page`, `meta`, `site`, `data`, `pages`, `nav()`, `breadcrumbs`,
 * `titleList()` and `formatDate()`, plus `content` for layouts.
 */
import type {
	GlobalData,
	LayoutProps,
	PageEntry,
	PageMeta,
	PageProps,
	SiteInfo,
} from './jsx/index.js';

import { basePathOf } from './base-path.js';
import {
	formatDate,
	getBreadcrumbs,
	getNavTree,
	titleList,
	type BreadcrumbItem,
	type GetNavTreeOptions,
	type PageInfo,
	type TitleListOptions,
} from './page-data/index.js';

/** What the core sends along with the render jobs. */
export interface RenderContext {
	readonly site: SiteInfo;
	readonly data: GlobalData;
	readonly pages: readonly PageEntry[];
	/** Why a data file that is a script has no value: the key and the reason. */
	readonly dataErrors?: Readonly<Record<string, string>>;
}

const infoCache = new WeakMap<RenderContext, readonly PageInfo[]>();

/**
 * The pages in the shape the page-data helpers take, built once per context.
 * @param context - The render context
 */
function pageInfos(context: RenderContext): readonly PageInfo[] {
	let infos = infoCache.get(context);
	if (!infos) {
		infos = context.pages.map((p) => ({
			url: p.url,
			filePathStem: p.filePathStem,
			meta: p.meta,
		}));
		infoCache.set(context, infos);
	}
	return infos;
}

/**
 * Creates the props of one page. `breadcrumbs` is computed when it is read,
 * because scanning the whole page list for every page costs more than most
 * pages need.
 * @param context - Site, data and the page list
 * @param index - The page's index in `context.pages`
 * @param extra - Further props (`content` for a layout)
 * @param extra.content
 * @example
 * ```ts
 * const props = createProps(context, 0, { content: '<p>body</p>' });
 * props.titleList({ separator: ' - ' });
 * ```
 */
export function createProps(
	context: RenderContext,
	index: number,
	extra: { readonly content: string },
): LayoutProps;
export function createProps(
	context: RenderContext,
	index: number,
	extra?: Record<string, unknown>,
): PageProps;
export function createProps(
	context: RenderContext,
	index: number,
	extra?: Record<string, unknown>,
): PageProps {
	const page = context.pages[index]!;
	const infos = pageInfos(context);
	const info = infos[index]!;
	let crumbs: BreadcrumbItem<PageMeta>[] | undefined;
	const breadcrumbs = (): BreadcrumbItem<PageMeta>[] => {
		crumbs ??= getBreadcrumbs<PageMeta>(
			{ page: info, pageList: infos },
			{ baseURL: basePathOf(context.site.baseURL) },
		);
		return crumbs;
	};
	const props = {
		page,
		meta: page.meta,
		site: context.site,
		data: context.data,
		pages: context.pages,
		nav: (options?: GetNavTreeOptions<PageMeta>) =>
			getNavTree<PageMeta>({ currentPage: page, pages: infos }, options),
		titleList: (options?: TitleListOptions): string =>
			titleList(breadcrumbs(), {
				siteName: context.site.siteName ?? undefined,
				...options,
			}),
		formatDate,
	};
	Object.defineProperty(props, 'breadcrumbs', {
		get: breadcrumbs,
		enumerable: true,
		configurable: true,
	});
	if (extra) {
		Object.assign(props, extra);
	}
	return props as PageProps;
}

export {
	type GlobalData,
	type LayoutProps,
	type PageEntry,
	type PageMeta,
	type PageProps,
	type SiteInfo,
} from './jsx/index.js';
export { basePathOf } from './base-path.js';
