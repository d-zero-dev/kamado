import type { BreadcrumbItem } from './breadcrumbs.js';

/**
 * Options for {@link titleList}.
 */
export type TitleListOptions = {
	/** Separator between titles. Default `' | '`. */
	readonly separator?: string;
	/** Base URL; items with this URL (and `/`) are excluded. Default `'/'`. */
	readonly baseURL?: string;
	/** String prepended to the title. Default `''`. */
	readonly prefix?: string;
	/** String appended to the title. Default `siteName`. */
	readonly suffix?: string;
	/** Site name. */
	readonly siteName?: string;
	/** Used when no title remains. Default `siteName`. */
	readonly fallback?: string;
};

/**
 * Generates the title string from a breadcrumb list, deepest page first.
 * @param breadcrumbs - Breadcrumb items.
 * @param options - Title options.
 * @returns The title.
 * @example
 * ```ts
 * titleList(breadcrumbs, { separator: ' | ', siteName: 'My Site', prefix: '📄 ' });
 * // "📄 Page Title | SectionMy Site"
 * ```
 */
export function titleList(
	breadcrumbs: BreadcrumbItem[],
	options?: TitleListOptions,
): string {
	const {
		separator = ' | ',
		baseURL = '/',
		prefix = '',
		suffix = options?.siteName,
		fallback = options?.siteName,
	} = options ?? {};

	const titles = breadcrumbs
		.filter((item) => item.href !== baseURL && item.href !== '/')
		.toReversed()
		.map((item) => item.title?.trim())
		.filter((item): item is string => item != null);
	if (titles.length === 0 && fallback) {
		titles.push(fallback.trim());
	}
	let title = titles.join(separator);
	if (prefix) {
		title = prefix.trim() + title;
	}
	if (suffix) {
		title = title + suffix.trim();
	}
	return title;
}
