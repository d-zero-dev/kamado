import type { CompilableFile } from 'kamado/files';

import { getTitleFromDOM, titleCache } from './title-utils.js';

/**
 * Gets page title
 * @param page - Page file
 * @param optimizeTitle - Function to optimize title (optional)
 * @param safe - Whether to return an empty string if the page content is not found
 * @returns Page title (from metadata.title, HTML <title> tag, or file slug as fallback) or empty string if safe is true
 */
export async function getTitle(
	page: CompilableFile,
	optimizeTitle?: (title: string) => string,
	safe?: boolean,
) {
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
