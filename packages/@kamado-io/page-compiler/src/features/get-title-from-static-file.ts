import fs from 'node:fs';

import { getTitleFromDOM, titleCache } from './title-utils.js';

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
