import type { CompilableFile } from '../files/types.js';

import fs from 'node:fs';

const titleCache = new Map<string, string>();

/**
 *
 * @param page
 * @param optimizeTitle
 */
export async function getTitle(
	page: CompilableFile,
	optimizeTitle?: (title: string) => string,
) {
	const filePathStem = page.filePathStem;
	if (titleCache.has(filePathStem)) {
		return titleCache.get(filePathStem);
	}
	const pageContent = await page.get();
	const { metaData, content } = pageContent;
	const title =
		(metaData.title as string | undefined) ||
		getTitleFromDOM(content, optimizeTitle) ||
		page.fileSlug;
	titleCache.set(filePathStem, title);
	return title;
}

/**
 *
 * @param filePath
 * @param optimizeTitle
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
 *
 * @param content
 * @param optimizeTitle
 */
function getTitleFromDOM(content: string, optimizeTitle?: (title: string) => string) {
	const title = /<title>(.*?)<\/title>/i.exec(content)?.[1]?.trim() || '';
	return optimizeTitle?.(title) ?? title;
}
