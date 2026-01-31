import type { GetTitleOptions } from '../types.js';
import type { CompilableFile } from 'kamado/files';

import { getTitleFromDOM, titleCache } from './title-utils.js';

/**
 * Gets page title
 * @param page - Page file
 * @param options - Options (optimizeTitle, safe)
 * @returns Page title (from metadata.title, HTML <title> tag, or file slug as fallback) or empty string if safe is true
 * @example
 * ```typescript
 * const title = await getTitle(page, { safe: true });
 * const optimizedTitle = await getTitle(page, { optimizeTitle: (t) => t.toUpperCase() });
 * ```
 */
export async function getTitle(page: CompilableFile, options?: GetTitleOptions) {
	const { optimizeTitle, safe } = options ?? {};
	const filePathStem = page.filePathStem;
	if (titleCache.has(filePathStem)) {
		return titleCache.get(filePathStem);
	}
	const pageContent = await page.get().catch((error) => {
		if (safe) {
			return null;
		}
		throw error;
	});
	if (!pageContent) {
		return '';
	}
	const { metaData, content } = pageContent;
	const title =
		(metaData.title as string | undefined) ||
		getTitleFromDOM(content, optimizeTitle) ||
		page.fileSlug;
	titleCache.set(filePathStem, title);
	return title;
}
