import type { Node, PathListToTreeOptions } from './path-list-to-tree.js';

import path from 'node:path';

import { pathListToTree } from './path-list-to-tree.js';

/**
 * A page as the page-data helpers see it.
 */
export interface PageInfo {
	/** Output URL of the page (for example `/about/` or `/a/b.html`). */
	readonly url: string;
	/** Source path without extension, rooted at the site root (for example `/about/index`). */
	readonly filePathStem: string;
	/** Front matter / page meta. */
	readonly meta: Record<string, unknown>;
}

/**
 * Meta of a navigation node.
 */
export interface NavNodeMetaData {
	/** Page title. */
	readonly title: string;
}

/**
 * Navigation node. The title is `node.meta.title`.
 * @template M - Meta type of the pages.
 */
export type NavNode<M extends Record<string, unknown> = Record<string, unknown>> = Node<
	NavNodeMetaData & M
>;

/**
 * Options for {@link getNavTree}.
 * @template M - Meta type of the pages.
 */
export interface GetNavTreeOptions<
	M extends Record<string, unknown> = Record<string, unknown>,
> {
	/** Glob patterns of pages to ignore. */
	readonly ignoreGlobs?: string[];
	/**
	 * Depth of the subtree root (default: the current page's depth - 1).
	 * Depth 0 is `/`, 1 is `/about/`, 2 is `/about/history/`.
	 */
	readonly baseDepth?: number;
	/** `'path'`, a comparator function, or `null` (default) to keep the page order. */
	readonly comparator?: PathListToTreeOptions['comparator'];
	/** Return `false` to remove a node (its children are filtered first). */
	readonly filter?: (node: NavNode<M>) => boolean;
}

/**
 * Context of {@link getNavTree}.
 */
export interface GetNavTreeContext {
	/** The page being rendered. */
	readonly currentPage: { readonly url: string };
	/** Every page of the site. */
	readonly pages: readonly PageInfo[];
}

/**
 * Builds the navigation tree for the current page.
 * @template M - Meta type of the pages.
 * @param context - Current page and page list.
 * @param options - Tree options.
 * @returns The subtree rooted at the ancestor at `baseDepth`, or `null` when
 * the current page is not in the list, no ancestor exists at that depth, or
 * the filter removes the root.
 * @example
 * ```ts
 * const tree = getNavTree(
 * 	{ currentPage: { url: '/a/b.html' }, pages },
 * 	{ ignoreGlobs: ['/drafts/**'], baseDepth: 1 },
 * );
 * console.log(tree?.meta?.title);
 * ```
 */
export function getNavTree<M extends Record<string, unknown> = Record<string, unknown>>(
	context: GetNavTreeContext,
	options?: GetNavTreeOptions<M>,
): NavNode<M> | null {
	const { currentPage, pages } = context;
	// `Array.prototype.find` returns the first page with the URL; keep that
	// while turning the per-node lookup into a map hit.
	const pageByUrl = new Map<string, PageInfo>();
	for (const page of pages) {
		if (!pageByUrl.has(page.url)) {
			pageByUrl.set(page.url, page);
		}
	}

	const tree = pathListToTree<NavNodeMetaData & M>(
		pages.map((item) => item.url),
		{
			ignoreGlobs: options?.ignoreGlobs,
			comparator: options?.comparator ?? null,
			currentPath: currentPage.url,
			addMetaData: (node) => getMeta<M>(node.url, pageByUrl),
		},
	);

	// The root may lack a title (for example an empty one); recompute it.
	if (!tree.meta?.title && tree.url) {
		tree.meta = getMeta<M>(tree.url, pageByUrl);
	}

	const parentTree = getParentNodeTree<M>(currentPage.url, tree, options?.baseDepth);
	if (!parentTree) {
		return null;
	}

	if (options?.filter) {
		return filterTreeNodes(parentTree, options.filter);
	}
	return parentTree;
}

/**
 * Recursively filters a tree, children first.
 * @param node - Node to filter.
 * @param filterNode - Returns `true` to keep a node.
 * @returns The filtered node, or `null` when removed.
 */
function filterTreeNodes<M extends Record<string, unknown>>(
	node: NavNode<M>,
	filterNode: (node: NavNode<M>) => boolean,
): NavNode<M> | null {
	const filteredChildren = node.children
		.map((child) => filterTreeNodes(child as NavNode<M>, filterNode))
		.filter((child): child is NavNode<M> => !!child);
	const newNode = { ...node, children: filteredChildren };
	return filterNode(newNode) ? newNode : null;
}

/**
 * Finds the node marked as current.
 * @param tree - Tree to search.
 * @returns The current node, or null.
 */
function findCurrentNode<M extends Record<string, unknown>>(
	tree: NavNode<M>,
): NavNode<M> | null {
	if (tree.current) {
		return tree;
	}
	for (const child of tree.children) {
		const found = findCurrentNode(child as NavNode<M>);
		if (found) {
			return found;
		}
	}
	return null;
}

/**
 * Finds the ancestor of the current URL at a depth.
 * @param currentUrl - Current page URL.
 * @param tree - Tree to search.
 * @param targetDepth - Depth to find (clamped to 0).
 * @returns The node, or null.
 */
function findAncestorAtDepth<M extends Record<string, unknown>>(
	currentUrl: string,
	tree: NavNode<M>,
	targetDepth: number,
): NavNode<M> | null {
	targetDepth = Math.max(0, targetDepth);
	if (tree.depth === targetDepth) {
		return tree;
	}
	const dirName = path.dirname(currentUrl) + '/';
	const candidateParent = tree.children.find((child) => {
		const childDir = child.url.endsWith('/') ? child.url : path.dirname(child.url) + '/';
		return dirName.startsWith(childDir);
	});
	if (!candidateParent) {
		return null;
	}
	return findAncestorAtDepth(currentUrl, candidateParent as NavNode<M>, targetDepth);
}

/**
 * Returns the subtree rooted at `baseDepth` along the current page's path.
 * @param currentUrl - Current page URL.
 * @param tree - Whole tree.
 * @param baseDepth - Depth of the subtree root (default: current depth - 1).
 * @returns The subtree, or null when the current page is not in the tree.
 */
function getParentNodeTree<M extends Record<string, unknown>>(
	currentUrl: string,
	tree: NavNode<M>,
	baseDepth?: number,
): NavNode<M> | null {
	const currentNode = findCurrentNode(tree);
	if (!currentNode) {
		return null;
	}
	return findAncestorAtDepth(currentUrl, tree, baseDepth ?? currentNode.depth - 1);
}

/**
 * Builds the meta of a node from its page.
 * @param url - Node URL.
 * @param pageByUrl - Pages keyed by URL (first occurrence wins).
 * @returns The page meta with a resolved `title`.
 */
function getMeta<M extends Record<string, unknown>>(
	url: string,
	pageByUrl: ReadonlyMap<string, PageInfo>,
): NavNodeMetaData & M {
	const page = pageByUrl.get(url);
	const title =
		(page?.meta?.title as string | undefined)?.trim() ??
		(page ? `__NO_TITLE__` : `⛔️ NOT FOUND (${url})`);
	return { ...(page?.meta ?? ({} as M)), title } as NavNodeMetaData & M;
}
