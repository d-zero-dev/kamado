import type { CompilableFile } from '../files/types.js';

import fs from 'node:fs';

const titleCache = new Map<string, string>();

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

/**
 * Gets title from static HTML file
 * @param filePath - HTML file path
 * @param optimizeTitle - Function to optimize title (optional)
 * @returns Title (null if not found)
 */
export function getTitleFromStaticFile(
	filePath: string,
	optimizeTitle?: (title: string) => string,
) {
	if (titleCache.has(filePath)) {
		return titleCache.get(filePath);
	}
	if (!fs.existsSync(filePath)) {
		return null;
	}
	const content = fs.readFileSync(filePath, 'utf8');
	let title = getTitleFromDOM(content, optimizeTitle);
	title = optimizeTitle?.(title) ?? title;
	titleCache.set(filePath, title);
	return title;
}

/**
 * Extracts title from HTML content using DOM parsing
 * @param content - HTML content
 * @param optimizeTitle - Function to optimize title (optional)
 * @returns Extracted title string (empty string if not found)
 */
function getTitleFromDOM(content: string, optimizeTitle?: (title: string) => string) {
	const title = /<title>(.*?)<\/title>/i.exec(content)?.[1]?.trim() || '';
	return optimizeTitle?.(title) ?? title;
}
