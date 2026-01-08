import type { CompilableFile } from '../files/types.js';
import type { Node } from '@d-zero/shared/path-list-to-tree';

import path from 'node:path';

import { pathListToTree } from '@d-zero/shared/path-list-to-tree';

import { getTitleFromStaticFile } from './title.js';

/**
 * Options for getting navigation tree
 */
export type GetNavTreeOptions = {
	/**
	 * List of glob patterns for files to ignore
	 */
	readonly ignoreGlobs?: string[];
};

/**
 * Gets navigation tree corresponding to the current page
 * @deprecated This function will be removed in the next major version (v2.0.0).
 * Import from '@kamado-io/page-compiler' instead.
 * @param currentPage - Current page file
 * @param pages - List of all page files (with titles)
 * @param optimizeTitle - Function to optimize titles (optional)
 * @param options - Options for getting navigation tree
 * @returns Navigation tree node (third-level ancestor node) or null if current page is at level 2 or below
 * @example
 * ```typescript
 * const navTree = getNavTree(currentPage, pageList, undefined, {
 *   ignoreGlobs: ['./drafts'],
 * });
 * ```
 */
export function getNavTree(
	currentPage: CompilableFile,
	pages: readonly (CompilableFile & { title: string })[],
	optimizeTitle?: (title: string) => string,
	options?: GetNavTreeOptions,
) {
	const tree = pathListToTree(
		pages.map((item) => item.url),
		{
			ignoreGlobs: options?.ignoreGlobs,
			currentPath: currentPage.url,
			filter: (node) => {
				const page = pages.find((item) => item.url === node.url);
				if (page) {
					// @ts-ignore
					node.title = page.title;
				} else {
					const filePath = node.url + (node.url.endsWith('/') ? 'index.html' : '');
					// @ts-ignore
					node.title =
						getTitleFromStaticFile(
							path.join(process.cwd(), 'htdocs', filePath),
							optimizeTitle,
						) ?? `⛔️ NOT FOUND (${node.stem})`;
				}
				return true;
			},
		},
	);

	const parentTree = getParentNodeTree(currentPage.url, tree);

	return parentTree;
}

/**
 * Finds the node corresponding to the current page in the tree
 * @param currentUrl - Current page URL
 * @param tree - Navigation tree
 * @returns Found node or null if not found
 */
function findCurrentNode(currentUrl: string, tree: Node): Node | null {
	if (tree.url === currentUrl) {
		return tree;
	}
	for (const child of tree.children) {
		const found = findCurrentNode(currentUrl, child);
		if (found) {
			return found;
		}
	}
	return null;
}

/**
 * Finds ancestor node at the specified depth
 * @param currentUrl - Current page URL
 * @param tree - Navigation tree
 * @param targetDepth - Target depth to find ancestor
 * @returns Found ancestor node or null if not found
 */
function findAncestorAtDepth(
	currentUrl: string,
	tree: Node,
	targetDepth: number,
): Node | null {
	// If the current node is at the target depth and is an ancestor of the current URL
	if (tree.depth === targetDepth && (tree.url === currentUrl || tree.isAncestor)) {
		return tree;
	}
	// Recursively search child nodes
	for (const child of tree.children) {
		const found = findAncestorAtDepth(currentUrl, child, targetDepth);
		if (found) {
			return found;
		}
	}
	return null;
}

/**
 * Returns the third-level navigation tree corresponding to the current page
 *
 * Note: The relationship between specification "level N" and path-list-to-tree "depth" is as follows:
 * - Specification level 1 (/) = depth 0
 * - Specification level 2 (/about/) = depth 1
 * - Specification level 3 (/about/history/) = depth 2
 * - Specification level 4 (/about/history/2025/) = depth 3
 * In other words, specification "level N" = depth (N-1)
 * @param currentUrl - Current page URL
 * @param tree - Navigation tree
 * @returns Third-level ancestor node or null if current page is at level 2 or below
 */
function getParentNodeTree(currentUrl: string, tree: Node): Node | null {
	// Find the node for the current page
	const currentNode = findCurrentNode(currentUrl, tree);

	if (!currentNode) {
		return null;
	}

	// If the current node is at the 2nd level or below (depth <= 1), return null (navigation not displayed)
	if (currentNode.depth <= 1) {
		return null;
	}

	// Find the 3rd level (depth === 2) ancestor node
	const level3Ancestor = findAncestorAtDepth(currentUrl, tree, 2);

	return level3Ancestor;
}
