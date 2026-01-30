/**
 * Internal cache for storing page titles
 */
export const titleCache = new Map<string, string>();

/**
 * Extracts title from HTML content using DOM parsing
 * @param content - HTML content
 * @param optimizeTitle - Function to optimize title (optional)
 * @returns Extracted title string (empty string if not found)
 */
export function getTitleFromDOM(
	content: string,
	optimizeTitle?: (title: string) => string,
) {
	const title = /<title>(.*?)<\/title>/i.exec(content)?.[1]?.trim() || '';
	return optimizeTitle?.(title) ?? title;
}
