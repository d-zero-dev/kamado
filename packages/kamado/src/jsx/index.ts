/**
 * Public entry of `kamado/jsx`: the HTML helpers, page/layout prop types, and
 * `basePathOf`. Compiled page modules import {@link ./runtime.js} directly
 * (see `RUNTIME_URL`); authors import this package path.
 *
 * Projects extend {@link PageMeta} and {@link GlobalData} by declaration
 * merging on `'kamado/jsx'`.
 * @example
 * ```ts
 * declare module 'kamado/jsx' {
 * 	interface PageMeta {
 * 		ogImage?: string;
 * 	}
 * 	interface GlobalData {
 * 		'bge-blocks': string;
 * 	}
 * }
 * ```
 * @module
 */
/// <reference types="react" />

import type {
	BreadcrumbItem,
	GetNavTreeOptions,
	NavNode,
	TitleListOptions,
} from '../page-data/index.js';

export { basePathOf } from '../base-path.js';
export type { HtmlChild } from './runtime.js';
export {
	Fragment,
	Markup,
	a,
	c,
	el,
	html,
	k,
	m,
	preloadImage,
	render,
	styleOf,
} from './runtime.js';

/**
 * Per-page meta after §4 merge. Empty so projects can add keys by
 * declaration merging on `'kamado/jsx'`.
 * @example
 * ```ts
 * declare module 'kamado/jsx' {
 * 	interface PageMeta {
 * 		ogImage?: string;
 * 	}
 * }
 * ```
 */
export interface PageMeta {
	readonly [key: string]: unknown;
}

/**
 * Site-wide `data` (files under `data.dir` plus `data.values`). Empty so
 * projects can add keys by declaration merging on `'kamado/jsx'`.
 * @example
 * ```ts
 * declare module 'kamado/jsx' {
 * 	interface GlobalData {
 * 		'bge-blocks': string;
 * 	}
 * }
 * ```
 */
export interface GlobalData {
	readonly [key: string]: unknown;
}

/**
 * A page as the core describes it for JSX props.
 * @example
 * ```ts
 * import type { PageEntry } from 'kamado/jsx';
 *
 * function urlOf(page: PageEntry): string {
 * 	return page.url;
 * }
 * ```
 */
export interface PageEntry {
	readonly url: string;
	readonly inputPath: string;
	readonly outputPath: string;
	readonly fileSlug: string;
	readonly filePathStem: string;
	readonly extension: string;
	/** ISO 8601 time the file object was created (the build's start). */
	readonly date: string;
	readonly meta: PageMeta;
}

/**
 * The `site` values of the config.
 * @example
 * ```ts
 * import type { SiteInfo } from 'kamado/jsx';
 *
 * function hostOf(site: SiteInfo): string | null {
 * 	return site.host;
 * }
 * ```
 */
export interface SiteInfo {
	readonly host: string | null;
	readonly baseURL: string | null;
	readonly siteName: string | null;
	readonly siteNameEn: string | null;
	readonly name: string | null;
	readonly version: string | null;
}

/**
 * Props of a page component (RFC §7.3).
 * @example
 * ```tsx
 * import type { PageProps } from 'kamado/jsx';
 *
 * export default function Page(props: PageProps) {
 * 	return <h1>{props.page.url}</h1>;
 * }
 * ```
 */
export interface PageProps {
	readonly page: PageEntry;
	readonly meta: PageMeta;
	readonly site: SiteInfo;
	readonly data: GlobalData;
	readonly pages: readonly PageEntry[];
	readonly nav: (options?: GetNavTreeOptions<PageMeta>) => NavNode<PageMeta> | null;
	readonly breadcrumbs: readonly BreadcrumbItem<PageMeta>[];
	readonly titleList: (options?: TitleListOptions) => string;
	readonly formatDate: (value: string | number | Date, format: string) => string;
}

/**
 * Props of a layout: {@link PageProps} plus the page's rendered HTML.
 * @example
 * ```tsx
 * import { html, type LayoutProps } from 'kamado/jsx';
 *
 * export default function Layout({ content, titleList }: LayoutProps) {
 * 	return (
 * 		<html>
 * 			<head>
 * 				<title>{titleList()}</title>
 * 			</head>
 * 			<body>{html(content)}</body>
 * 		</html>
 * 	);
 * }
 * ```
 */
export interface LayoutProps extends PageProps {
	readonly content: string;
}

// `<html static>` keeps the template order (RFC §7). Projects that type JSX
// with `@types/react` (a peer of this package) need this member.
declare module 'react' {
	// eslint-disable-next-line @typescript-eslint/no-unused-vars -- matches @types/react
	interface HtmlHTMLAttributes<T> {
		static?: boolean | undefined;
	}
}

export {
	type BreadcrumbItem,
	type GetNavTreeOptions,
	type NavNode,
	type TitleListOptions,
} from '../page-data/index.js';
