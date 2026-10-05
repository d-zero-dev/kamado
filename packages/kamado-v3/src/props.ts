/**
 * What a page or layout component receives as `props` (RFC section 7.3):
 * `page`, `meta`, `site`, `data`, `pages`, `nav()`, `breadcrumbs`,
 * `titleList()` and `formatDate()`, plus `content` for layouts.
 */
import {
	formatDate,
	getBreadcrumbs,
	getNavTree,
	titleList,
	type BreadcrumbItem,
	type GetNavTreeOptions,
	type NavNode,
	type PageInfo,
	type TitleListOptions,
} from './page-data/index.js';

/** A page as the core describes it. */
export interface PageEntry {
	readonly url: string;
	readonly inputPath: string;
	readonly outputPath: string;
	readonly fileSlug: string;
	readonly filePathStem: string;
	readonly extension: string;
	/** ISO 8601 time the file object was created (the build's start). */
	readonly date: string;
	readonly meta: Record<string, unknown>;
}

/** The `site` values of the config. */
export interface SiteInfo {
	readonly host: string | null;
	readonly baseURL: string | null;
	readonly siteName: string | null;
	readonly siteNameEn: string | null;
	readonly name: string | null;
	readonly version: string | null;
}

/** What the core sends along with the render jobs. */
export interface RenderContext {
	readonly site: SiteInfo;
	readonly data: Record<string, unknown>;
	readonly pages: readonly PageEntry[];
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
 * The path part of the site's base URL, which is what the breadcrumbs cut
 * at: `https://example.com/sub/` is `/sub/`, a plain path stays as it is.
 * @param baseURL - `site.baseURL`
 */
export function basePathOf(baseURL: string | null): string {
	if (!baseURL) {
		return '/';
	}
	if (baseURL.startsWith('/')) {
		return baseURL;
	}
	try {
		return new URL(baseURL).pathname;
	} catch {
		return '/';
	}
}

/**
 * Creates the props of one page. `breadcrumbs` is computed when it is read,
 * because scanning the whole page list for every page costs more than most
 * pages need.
 * @param context - Site, data and the page list
 * @param index - The page's index in `context.pages`
 * @param extra - Further props (`content` for a layout)
 * @example
 * ```ts
 * const props = createProps(context, 0, { content: '<p>body</p>' });
 * props.titleList({ separator: ' - ' });
 * ```
 */
export function createProps(
	context: RenderContext,
	index: number,
	extra?: Record<string, unknown>,
): Record<string, unknown> {
	const page = context.pages[index]!;
	const infos = pageInfos(context);
	const info = infos[index]!;
	let crumbs: BreadcrumbItem[] | undefined;
	const breadcrumbs = (): BreadcrumbItem[] => {
		crumbs ??= getBreadcrumbs(
			{ page: info, pageList: infos },
			{ baseURL: basePathOf(context.site.baseURL) },
		);
		return crumbs;
	};
	const props: Record<string, unknown> = {
		page,
		meta: page.meta,
		site: context.site,
		data: context.data,
		pages: context.pages,
		nav: (options?: GetNavTreeOptions): NavNode | null =>
			getNavTree({ currentPage: page, pages: infos }, options),
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
	return props;
}
