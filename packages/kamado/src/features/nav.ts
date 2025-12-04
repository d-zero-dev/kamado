import type { CompilableFile } from '../files/types.js';
import type { Node } from '@d-zero/shared/path-list-to-tree';

import path from 'node:path';

import { pathListToTree } from '@d-zero/shared/path-list-to-tree';

import { getTitleFromStaticFile } from './title.js';

export type GetNavTreeOptions = {
	readonly ignoreGlobs?: string[];
};

/**
 *
 * @param currentPage
 * @param pages
 * @param optimizeTitle
 * @param options
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
 * ツリーから現在のページのノードを見つける
 * @param currentUrl
 * @param tree
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
 * 指定された深さの祖先ノードを見つける
 * @param currentUrl
 * @param tree
 * @param targetDepth
 */
function findAncestorAtDepth(
	currentUrl: string,
	tree: Node,
	targetDepth: number,
): Node | null {
	// 現在のノードが目的の深さで、かつ現在のURLの祖先である場合
	if (tree.depth === targetDepth && (tree.url === currentUrl || tree.isAncestor)) {
		return tree;
	}
	// 子ノードを再帰的に探索
	for (const child of tree.children) {
		const found = findAncestorAtDepth(currentUrl, child, targetDepth);
		if (found) {
			return found;
		}
	}
	return null;
}

/**
 * 現在のページに対応する第3階層のナビゲーションツリーを返す
 *
 * 注意: 仕様書の「第N階層」とpath-list-to-treeの「depth」は以下のように対応する:
 * - 仕様の第1階層 (/) = depth 0
 * - 仕様の第2階層 (/about/) = depth 1
 * - 仕様の第3階層 (/about/history/) = depth 2
 * - 仕様の第4階層 (/about/history/2025/) = depth 3
 * つまり、仕様の「第N階層」= depth (N-1)
 * @param currentUrl
 * @param tree
 */
function getParentNodeTree(currentUrl: string, tree: Node): Node | null {
	// 現在のページのノードを見つける
	const currentNode = findCurrentNode(currentUrl, tree);

	if (!currentNode) {
		return null;
	}

	// 仕様の第2階層以下 (depth <= 1) の場合はnullを返す（ナビゲーション非表示）
	if (currentNode.depth <= 1) {
		return null;
	}

	// 仕様の第3階層 (depth === 2) の祖先ノードを見つける
	const level3Ancestor = findAncestorAtDepth(currentUrl, tree, 2);

	return level3Ancestor;
}
