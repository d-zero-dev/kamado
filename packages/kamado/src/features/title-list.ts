import type { BreadcrumbItem } from './breadcrumbs.js';

/**
 * Options for generating title list
 */
export type TitleListOptions = {
	/**
	 * Separator between titles
	 * @default ' | '
	 */
	readonly separator?: string;
	/**
	 * Base URL (items with this URL are excluded)
	 * @default '/'
	 */
	readonly baseURL?: string;
	/**
	 * String to prepend to title
	 * @default ''
	 */
	readonly prefix?: string;
	/**
	 * String to append to title
	 * @default options.siteName
	 */
	readonly suffix?: string;
	/**
	 * Site name
	 */
	readonly siteName?: string;
	/**
	 * Fallback string when title is empty
	 * @default options.siteName
	 */
	readonly fallback?: string;
};

/**
 * Generates title string from breadcrumb list
 * @deprecated This function will be removed in the next major version (v2.0.0).
 * Import from '@kamado-io/page-compiler' instead.
 * @param breadcrumbs - Array of breadcrumb items
 * @param options - Options for generating title list
 * @returns Generated title string
 * @example
 * ```typescript
 * const title = titleList(breadcrumbs, {
 *   separator: ' | ',
 *   siteName: 'My Site',
 *   prefix: '📄 ',
 * });
 * // Returns: "📄 Page Title | Section | My Site"
 * ```
 */
export function titleList(breadcrumbs: BreadcrumbItem[], options: TitleListOptions = {}) {
	const {
		separator = ' | ',
		baseURL = '/',
		prefix = '',
		suffix = options.siteName,
		fallback = options.siteName,
	} = options;

	const titleList = breadcrumbs
		.filter((item) => item.href !== baseURL && item.href !== '/')
		.toReversed()
		.map((item) => item.title?.trim())
		.filter((item): item is string => item != null);
	if (titleList.length === 0 && fallback) {
		titleList.push(fallback.trim());
	}
	let title = titleList.join(separator);
	if (prefix) {
		title = prefix.trim() + title;
	}
	if (suffix) {
		title = title + suffix.trim();
	}
	return title;
}
