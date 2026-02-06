import type { Node } from '@d-zero/shared/path-list-to-tree';
import type { CompilableFile, PageData } from 'kamado/files';

import path from 'node:path';

import { pathListToTree } from '@d-zero/shared/path-list-to-tree';

/**
 * Navigation node with title
 */
export type NavNode = Node & {
	/**
	 * Title
	 */
	readonly title: string;
};

/**
 * Options for getting navigation tree
 * @template TOut - Type of additional properties added by transformNode
 */
export type GetNavTreeOptions<
	TOut extends Record<string, unknown> = Record<never, never>,
> = {
	/**
	 * List of glob patterns for files to ignore
	 */
	readonly ignoreGlobs?: string[];
	/**
	 * Base depth for navigation tree (default: 1)
	 * - 0: Level 2 (e.g. /about/)
	 * - 1: Level 3 (e.g. /about/history/)
	 */
	readonly baseDepth?: number;
	/**
	 * Transform each navigation node
	 * @param node - Original navigation node
	 * @returns Transformed navigation node with additional properties (or null/undefined to remove the node)
	 */
	readonly transformNode?: (node: NavNode) => (NavNode & TOut) | null | undefined;
};

/**
 * Gets navigation tree corresponding to the current page
 * @template TOut - Type of additional properties added by transformNode
 * @param currentPage - Current page file
 * @param pages - List of all page files (with titles)
 * @param options - Options for getting navigation tree
 * @returns Navigation tree node at the specified baseDepth (default: current page's depth - 1) or null if not found
 * @example
 * ```typescript
 * const navTree = getNavTree(currentPage, pageList, {
 *   ignoreGlobs: ['./drafts'],
 * });
 * ```
 * @example
 * ```typescript
 * // With transformNode for adding custom properties
 * const navTree = getNavTree(currentPage, pageList, {
 *   transformNode: (node) => {
 *     return {
 *       ...node,
 *       badge: 'new',
 *     };
 *   },
 * });
 * ```
 */
/**
 * Required context for navigation tree generation
 */
export interface GetNavTreeContext {
	readonly currentPage: CompilableFile;
	readonly pages: readonly PageData[];
}

/**
 *
 * @param context
 * @param options
 */
export function getNavTree<TOut extends Record<string, unknown> = Record<never, never>>(
	context: GetNavTreeContext,
	options?: GetNavTreeOptions<TOut>,
): (NavNode & TOut) | null | undefined {
	const { currentPage, pages } = context;
	const tree = pathListToTree(
		pages.map((item) => item.url),
		{
			ignoreGlobs: options?.ignoreGlobs,
			currentPath: currentPage.url,
			filter: (node) => {
				const page = pages.find((item) => item.url === node.url);
				// @ts-ignore
				node.title =
					(page?.metaData?.title as string | undefined)?.trim() ||
					(page ? `__NO_TITLE__` : `⛔️ NOT FOUND (${node.stem})`);
				return true;
			},
		},
	) as NavNode;

	// Ensure root node has title (pathListToTree might skip filter for root)
	if (!tree.title && tree.url) {
		const page = pages.find((item) => item.url === tree.url);
		// @ts-ignore
		tree.title =
			(page?.metaData?.title as string | undefined)?.trim() ||
			(page ? `__NO_TITLE__` : `⛔️ NOT FOUND (${tree.stem})`);
	}

	const parentTree = getParentNodeTree(currentPage.url, tree, options?.baseDepth);

	if (!parentTree) {
		return null;
	}

	// Apply transformNode if specified
	if (options?.transformNode) {
		return transformTreeNodes(parentTree, options.transformNode);
	}

	return parentTree as NavNode & TOut;
}

/**
 * Recursively transforms all nodes in a tree
 * @param node - Root node to transform
 * @param transformNode - Transform function
 * @returns Transformed tree
 */
function transformTreeNodes<TOut extends Record<string, unknown>>(
	node: NavNode,
	transformNode: (node: NavNode) => (NavNode & TOut) | null | undefined,
): (NavNode & TOut) | null | undefined {
	const transformedChildren = node.children
		.map((child) => transformTreeNodes(child as NavNode, transformNode))
		.filter((child): child is NavNode & TOut => !!child);

	const transformedNode = transformNode({
		...node,
		children: transformedChildren,
	});

	return transformedNode;
}

/**
 * Finds the node corresponding to the current page in the tree
 * @param tree - Navigation tree
 * @returns Found node or null if not found
 */
function findCurrentNode(tree: Node): Node | null {
	if (tree.current) {
		return tree;
	}
	for (const child of tree.children) {
		const found = findCurrentNode(child);
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
	tree: NavNode,
	targetDepth: number,
): NavNode | null {
	targetDepth = Math.max(0, targetDepth);
	if (tree.depth === targetDepth) {
		return tree;
	}
	const dirName = path.dirname(currentUrl) + '/';
	const candidateParent = tree.children.find((child) =>
		dirName.startsWith(child.url.endsWith('/') ? child.url : path.dirname(child.url)),
	);
	if (!candidateParent) {
		return null;
	}

	const found = findAncestorAtDepth(currentUrl, candidateParent as NavNode, targetDepth);
	if (found) {
		return found;
	}

	return null;
}

/**
 * Returns the navigation tree corresponding to the current page at the specified base depth
 *
 * Note: The relationship between specification "level N" and path-list-to-tree "depth" is as follows:
 * - Specification level 1 (/) = depth 0
 * - Specification level 2 (/about/) = depth 1
 * - Specification level 3 (/about/history/) = depth 2
 * - Specification level 4 (/about/history/2025/) = depth 3
 * In other words, specification "level N" = depth (N-1)
 * @param currentUrl - Current page URL
 * @param tree - Navigation tree
 * @param baseDepth - Base depth for navigation tree (default: current page's depth - 1)
 * @returns Ancestor node at baseDepth or null if not found
 */
function getParentNodeTree(
	currentUrl: string,
	tree: NavNode,
	baseDepth?: number,
): NavNode | null {
	// Find the node for the current page
	const currentNode = findCurrentNode(tree);

	if (!currentNode) {
		return null;
	}

	// Find the ancestor node at baseDepth (default: current page's depth - 1)
	const ancestor = findAncestorAtDepth(
		currentUrl,
		tree,
		baseDepth ?? currentNode.depth - 1,
	);

	return ancestor;
}
