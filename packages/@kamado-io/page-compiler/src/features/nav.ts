import type { Node } from '@d-zero/shared/path-list-to-tree';
import type { CompilableFile, PageData } from 'kamado/files';

import path from 'node:path';

import { pathListToTree } from '@d-zero/shared/path-list-to-tree';

/**
 * Navigation node with metadata
 *
 * Uses `Node<NavNodeMetaData>` from `@d-zero/shared/path-list-to-tree`.
 * Access title via `node.meta.title`.
 */
export type NavNode = Node<NavNodeMetaData>;

/**
 * Metadata for navigation node
 */
export interface NavNodeMetaData {
	/**
	 * Page title
	 */
	readonly title: string;
}

/**
 * Options for getting navigation tree
 */
export interface GetNavTreeOptions {
	/**
	 * Glob patterns for files to ignore
	 */
	readonly ignoreGlobs?: string[];
	/**
	 * Base depth for navigation tree (default: current page's depth - 1)
	 *
	 * Depth corresponds to URL hierarchy:
	 * - depth 0: `/`
	 * - depth 1: `/about/`
	 * - depth 2: `/about/history/`
	 */
	readonly baseDepth?: number;
	/**
	 * Filter navigation nodes
	 *
	 * Return `true` to keep the node, `false` to remove it from the tree.
	 */
	readonly filter?: (node: NavNode) => boolean;
}

/**
 * Context for navigation tree generation
 */
export interface GetNavTreeContext {
	/**
	 * Current page file
	 */
	readonly currentPage: CompilableFile;
	/**
	 * List of all pages with metadata
	 */
	readonly pages: readonly PageData[];
}

/**
 * Gets navigation tree corresponding to the current page
 *
 * Title is accessed via `node.meta.title`.
 * @param context - Context containing current page and page list
 * @param options - Options for tree generation
 * @returns Navigation tree or null if not found
 * @example
 * ```typescript
 * const navTree = getNavTree(
 *   { currentPage, pages: pageList },
 *   { ignoreGlobs: ['./drafts'] },
 * );
 *
 * // Access title
 * console.log(navTree?.meta.title);
 * ```
 * @example
 * ```typescript
 * // Filter nodes
 * const navTree = getNavTree(
 *   { currentPage, pages: pageList },
 *   {
 *     filter: (node) => !node.url.includes('/drafts/'),
 *   },
 * );
 * ```
 */
export function getNavTree(
	context: GetNavTreeContext,
	options?: GetNavTreeOptions,
): NavNode | null | undefined {
	const { currentPage, pages } = context;
	const tree = pathListToTree<NavNodeMetaData>(
		pages.map((item) => item.url),
		{
			ignoreGlobs: options?.ignoreGlobs,
			currentPath: currentPage.url,
			addMetaData: (node) => getMeta(node.url, pages),
		},
	);

	// Ensure root node has meta (pathListToTree may skip addMetaData for root)
	if (!tree.meta?.title && tree.url) {
		tree.meta = getMeta(tree.url, pages);
	}

	const parentTree = getParentNodeTree(currentPage.url, tree, options?.baseDepth);

	if (!parentTree) {
		return null;
	}

	// Apply transformNode if specified
	if (options?.filter) {
		return filterTreeNodes(parentTree, options.filter);
	}

	return parentTree;
}

/**
 * Recursively filters all nodes in a tree
 * @param node - Root node to filter
 * @param filterNode - Filter function returning true to keep, false to remove
 */
function filterTreeNodes(
	node: NavNode,
	filterNode: (node: NavNode) => boolean,
): NavNode | null | undefined {
	const filteredChildren = node.children
		.map((child) => filterTreeNodes(child as NavNode, filterNode))
		.filter((child): child is NavNode => !!child);

	const newNode = {
		...node,
		children: filteredChildren,
	};

	const isExists = filterNode(newNode);

	return isExists ? newNode : null;
}

/**
 * Finds the node marked as current in the tree
 * @param tree - Navigation tree to search
 */
function findCurrentNode(tree: NavNode): NavNode | null {
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
 * @param tree - Navigation tree to search
 * @param targetDepth - Target depth to find ancestor
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

	const found = findAncestorAtDepth(currentUrl, candidateParent, targetDepth);
	if (found) {
		return found;
	}

	return null;
}

/**
 * Returns the subtree starting from the ancestor at the specified base depth
 * @param currentUrl - Current page URL
 * @param tree - Navigation tree
 * @param baseDepth - Base depth for navigation tree
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

/**
 * Gets metadata for a navigation node from page list
 * @param url - Page URL
 * @param pages - List of pages with metadata
 */
function getMeta(url: string, pages: readonly PageData[]): NavNodeMetaData {
	const page = pages.find((item) => item.url === url);
	return {
		...page?.metaData,
		title:
			(page?.metaData?.title as string | undefined)?.trim() ??
			(page ? `__NO_TITLE__` : `⛔️ NOT FOUND (${url})`),
	};
}
