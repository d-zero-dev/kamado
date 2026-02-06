/**
 * Extracts title from HTML string
 * Searches only in the <head> section for performance
 * @param html - HTML content
 * @returns Title string (empty string if not found)
 */
export function getTitleFromHtmlString(html: string): string {
	// Split at <body to only search in the head section
	const headSection = html.split(/<body[\s>]/i)[0] ?? html;
	const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(headSection);
	return match?.[1]?.trim() ?? '';
}
