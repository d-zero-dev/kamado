import type { BreadcrumbItem } from './breadcrumbs.js';

export type TitleListOptions = {
	readonly separator?: string;
	readonly baseURL?: string;
	readonly prefix?: string;
	readonly suffix?: string;
	readonly siteName?: string;
	readonly fallback?: string;
};

/**
 * @param breadcrumbs
 * @param options
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
