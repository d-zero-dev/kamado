/**
 * Port of `@d-zero/shared`'s `pathListToTree` (with the `parseUrl` and
 * `pathComparator` helpers it depends on), so the Node layer carries no runtime
 * dependency. Behaviour, including error cases, is identical to the original;
 * the only structural change is that the comparator caches the per-path
 * parse (a pure function of the string) so a sort does not rebuild a `URL`
 * for every comparison.
 */
import path from 'node:path';

/**
 * Options for building a tree from a list of paths.
 * @template MetaData - Type of the meta attached to each node via `addMetaData`.
 */
export type PathListToTreeOptions<MetaData = Record<string, unknown>> = {
	/** Path treated as the current item (sets `current` and `isAncestor`). */
	currentPath?: string;
	/** Base URL used when resolving paths to stems. */
	baseUrl?: string;
	/** Extra file extensions to include; `.html` and `.htm` are always included. */
	extensions?: string[];
	/** Glob patterns (`path.matchesGlob`) for paths to ignore. */
	ignoreGlobs?: string[];
	/** Create virtual parents for missing ancestors (default `true`); otherwise throw. */
	createVirtualParent?: boolean;
	/**
	 * Sort comparator for the path list.
	 * - `'path'` (default): {@link pathComparator}
	 * - function: custom comparator
	 * - `null`: keep the original order
	 */
	comparator?: 'path' | ((a: string, b: string) => number) | null;
	/** Predicate; excluded nodes and their descendants are removed. */
	filter?: (node: Node<MetaData>) => boolean;
	/** Computes the meta of each node; applied after filtering. */
	addMetaData?: (node: Node<MetaData>) => MetaData;
};

/**
 * A node in the path tree.
 * @template MetaData - Type of the meta attached by `addMetaData`.
 */
export type Node<MetaData = Record<string, unknown>> = {
	/** Original path of the file or directory. */
	url: string;
	/** Normalised stem used as the node key. */
	stem: string;
	/** Depth in the tree (0 for the root). */
	depth: number;
	/** True if this node is the current path. */
	current: boolean;
	/** True if this node is a directory ancestor of the current path. */
	isAncestor: boolean;
	/** Present when the node was created as a virtual parent (no real file). */
	virtual?: true;
	/** Meta data when `addMetaData` is given. */
	meta?: MetaData;
	/** Child nodes. */
	children: Node<MetaData>[];
};

/**
 * Builds a tree from a list of paths. Paths are sorted, filtered by extension
 * and `ignoreGlobs`, organised into a tree, then `filter` and `addMetaData` are
 * applied in that order.
 * @template MetaData - Type of the meta attached by `addMetaData`.
 * @param pathList - Paths (for example page URLs).
 * @param options - Sorting, filtering, current path and meta options.
 * @returns The root node (stem `/`).
 * @throws {Error} When the root is missing, or a parent is missing and `createVirtualParent` is false.
 * @example
 * ```ts
 * const tree = pathListToTree(['/', '/a/', '/a/b.html'], { currentPath: '/a/b.html' });
 * // tree.children[0].url === '/a/', tree.children[0].isAncestor === true
 * ```
 */
export function pathListToTree<MetaData = Record<string, unknown>>(
	pathList: string[],
	options?: PathListToTreeOptions<MetaData>,
): Node<MetaData> {
	const comparator = options?.comparator === undefined ? 'path' : options.comparator;
	const sortedList =
		comparator === null
			? pathList
			: comparator === 'path'
				? pathList.toSorted(createPathComparator())
				: pathList.toSorted(comparator);
	const currentPath = options?.currentPath;
	const baseUrl = options?.baseUrl ?? 'https://example.com';
	const extensions = new Set([
		'.html',
		'.htm',
		...(options?.extensions?.map((extension) => extension.toLowerCase().trim()) ?? []),
	]);
	const ignoreGlobs = options?.ignoreGlobs ?? [];
	const createVirtualParent = options?.createVirtualParent ?? true;
	const filter = options?.filter ?? (() => true);

	const fileList: Node<MetaData>[] = [];
	for (const filePath of sortedList) {
		const extname = path.extname(filePath).toLowerCase().trim();
		if (ignoreGlobs.some((glob) => path.matchesGlob(filePath, glob))) {
			continue;
		}
		if (extname && !extensions.has(extname)) {
			continue;
		}
		const url = parseStem(filePath, baseUrl);
		const current = filePath === currentPath;
		fileList.push({
			url: filePath,
			stem: url.stem,
			depth: url.depth,
			current,
			isAncestor:
				!current && currentPath
					? url.stem.endsWith('/') && currentPath.startsWith(url.stem)
					: false,
			children: [],
		});
	}

	let tree = createTree(fileList, createVirtualParent);
	tree = walkFilter(tree, filter);
	if (options?.addMetaData) {
		tree = walkForAddMetaData(tree, options.addMetaData);
	}
	return tree;
}

/**
 * Recursively filters the tree; nodes the callback rejects (and their subtrees) are removed.
 * @param node - Current node.
 * @param callback - Predicate; `false` removes the node.
 * @returns A shallow copy with filtered children.
 */
function walkFilter<MetaData>(
	node: Node<MetaData>,
	callback: (node: Node<MetaData>) => boolean,
): Node<MetaData> {
	const newChildren: Node<MetaData>[] = [];
	for (const child of node.children) {
		if (!callback(child)) {
			continue;
		}
		newChildren.push(walkFilter(child, callback));
	}
	return { ...node, children: newChildren };
}

/**
 * Recursively attaches meta to each node.
 * @param node - Current node.
 * @param createMetaData - Returns the meta for a node.
 * @returns A shallow copy with `meta` and updated children.
 */
function walkForAddMetaData<MetaData>(
	node: Node<MetaData>,
	createMetaData: (node: Node<MetaData>) => MetaData,
): Node<MetaData> {
	const metaData = createMetaData(node);
	const newChildren: Node<MetaData>[] = [];
	for (const child of node.children) {
		newChildren.push(walkForAddMetaData(child, createMetaData));
	}
	return { ...node, meta: metaData, children: newChildren };
}

/**
 * Builds the tree by linking each node to its parent.
 * @param fileList - Flat node list.
 * @param createVirtualParent - Create virtual parents for missing stems, or throw.
 * @returns The root node (stem `/`).
 * @throws {Error} When the root is missing or a parent is missing and virtual parents are disabled.
 */
function createTree<MetaData>(
	fileList: Node<MetaData>[],
	createVirtualParent: boolean,
): Node<MetaData> {
	const pathMap = new Map<string, Node<MetaData>>();
	for (const filePath of fileList) {
		pathMap.set(filePath.stem, filePath);
	}
	for (const filePath of fileList) {
		const node = pathMap.get(filePath.stem);
		if (!node) {
			continue;
		}
		addParent(node, pathMap, createVirtualParent);
	}
	const root = pathMap.get('/');
	if (!root) {
		throw new Error('Root node not found');
	}
	return root;
}

/**
 * Links a node to its parent, creating the parent as a virtual node if allowed.
 * @param node - Node to attach.
 * @param pathMap - Stem to node map; virtual parents are added to it.
 * @param createVirtualParent - Create a virtual parent when missing, or throw.
 * @throws {Error} When the parent is missing and virtual parents are disabled.
 */
function addParent<MetaData>(
	node: Node<MetaData>,
	pathMap: Map<string, Node<MetaData>>,
	createVirtualParent: boolean,
): void {
	const parentStem = getParentPath(node.stem);
	if (!parentStem) {
		return;
	}
	const parent = pathMap.get(parentStem);
	if (parent) {
		parent.children.push(node);
		return;
	}
	if (!createVirtualParent) {
		throw new Error(`Parent node not found: "${parentStem}"`);
	}
	const virtualParent: Node<MetaData> = {
		url: parentStem,
		stem: parentStem,
		depth: node.depth - 1,
		current: false,
		isAncestor: node.current || node.isAncestor,
		virtual: true,
		children: [node],
	};
	pathMap.set(parentStem, virtualParent);
	addParent(virtualParent, pathMap, createVirtualParent);
}

/**
 * Returns the parent stem (`/a/b/c/` becomes `/a/b/`), or null for the root.
 * @param filePathStem - Stem string.
 * @returns The parent stem.
 */
function getParentPath(filePathStem: string): string | null {
	if (filePathStem === '/') {
		return null;
	}
	const urlParts = filePathStem.split('/').filter(Boolean);
	const parentParts = urlParts.slice(0, -1);
	return parentParts.length === 0 ? '/' : '/' + parentParts.join('/') + '/';
}

/**
 * The part of `@d-zero/shared`'s `parseUrl` the tree needs (`stem` and `depth`
 * with `indexAsParent: true`). The other fields of the original result do not
 * influence these two, and nothing in the skipped part can throw.
 * @param url - Path or URL string.
 * @param baseUrl - Base URL to resolve against.
 * @returns The stem and depth; both empty/zero for non-HTTP or unparsable input.
 */
function parseStem(url: string, baseUrl: string): { stem: string; depth: number } {
	try {
		const whatwgUrl = new URL(url, baseUrl);
		const { protocol, pathname } = whatwgUrl;
		if (!/^https?:$/.test(protocol)) {
			return { stem: '', depth: 0 };
		}
		const normalized = pathname.replaceAll(/\/+/g, '/');
		const paths = normalized.replace(/^\//, '').split('/');
		const isNoName = normalized.endsWith('/');
		const extname = isNoName ? null : path.extname(normalized);
		const basename = isNoName ? null : path.basename(normalized, extname || '');
		const dirname =
			normalized === '/' ? null : path.dirname(normalized + (isNoName ? 'index' : ''));
		const isIndex = isNoName || basename?.toLowerCase() === 'index';
		const stem = `${dirname ?? ''}/${isIndex ? '' : (basename ?? '')}`.replaceAll(
			/\/+/g,
			'/',
		);
		return { stem, depth: paths.length - (isIndex ? 1 : 0) };
	} catch {
		return { stem: '', depth: 0 };
	}
}

/**
 * Compares two paths or URLs in "natural" site order: host, then directory
 * segments (index first, numeric-aware), then basename, extension, query, hash.
 * @param url1 - First path or URL string.
 * @param url2 - Second path or URL string.
 * @returns Negative, zero or positive, as for `Array.prototype.sort`.
 * @example
 * ```ts
 * ['/a/10.html', '/a/2.html', '/a/'].toSorted(pathComparator);
 * // ['/a/', '/a/2.html', '/a/10.html']
 * ```
 */
export function pathComparator(url1: string, url2: string): number {
	return compareParts(toURLParts(url1), toURLParts(url2));
}

/**
 * Returns a {@link pathComparator} that parses each distinct string once.
 * The parse is a pure function of the string, so ordering is identical.
 * @returns A caching comparator for a single sort.
 */
function createPathComparator(): (a: string, b: string) => number {
	const cache = new Map<string, URLParts>();
	const get = (url: string): URLParts => {
		let parts = cache.get(url);
		if (!parts) {
			parts = toURLParts(url);
			cache.set(url, parts);
		}
		return parts;
	};
	return (a, b) => compareParts(get(a), get(b));
}

type URLParts = {
	hostname: string;
	paths: string[];
	basename: string;
	isIndex: boolean;
	extname: string;
	search: string;
	hash: string;
	protocol: string;
	href: string;
	original: string;
};

/**
 * Parses a string into comparable parts.
 * @param url - Path or URL string.
 * @returns The parts.
 */
function toURLParts(url: string): URLParts {
	const u = pathToURL(url);
	const pathSegments = u.pathname.split('/');
	const lastSegment = pathSegments.at(-1) ?? pathSegments.at(0) ?? '';
	return {
		hostname: u.hostname,
		paths: pathSegments,
		basename: lastSegment,
		isIndex: lastSegment.toLowerCase() === 'index' || lastSegment === '',
		extname: path.extname(lastSegment),
		search: u.search,
		hash: u.hash,
		protocol: u.protocol,
		href: u.href,
		original: url,
	};
}

/**
 * Parses a string as a URL, falling back to resolving it against `file://`.
 * @param value - Path or URL string.
 * @returns The URL.
 */
function pathToURL(value: string): URL {
	try {
		return new URL(value);
	} catch (error) {
		if (error instanceof TypeError) {
			return new URL(value, 'file://');
		}
		throw error;
	}
}

/**
 * Compares two parsed paths.
 * @param u1 - First parts.
 * @param u2 - Second parts.
 * @returns Comparator result.
 */
function compareParts(u1: URLParts, u2: URLParts): number {
	if (u1.href === u2.href) {
		return alphabeticalComparator(u1.original, u2.original);
	}
	const rHost = alphabeticalComparator(u1.hostname, u2.hostname);
	if (rHost) {
		return rHost;
	}
	const rPaths = dirComparator(u1.paths, u2.paths);
	if (rPaths) {
		return rPaths;
	}
	if (u1.basename !== u2.basename) {
		if (u1.isIndex) return -1;
		if (u2.isIndex) return 1;
		const rBasename = numericalComparator(u1.basename, u2.basename);
		if (rBasename) {
			return rBasename;
		}
	}
	const rExt = numericalComparator(u1.extname, u2.extname);
	if (rExt) {
		return rExt;
	}
	const rSearch = numericalComparator(u1.search, u2.search);
	if (rSearch) {
		return rSearch;
	}
	const rHash = numericalComparator(u1.hash, u2.hash);
	if (rHash) {
		return rHash;
	}
	const rProtocol = alphabeticalComparator(u1.protocol, u2.protocol);
	if (rProtocol) {
		return rProtocol;
	}
	return numericalComparator(u1.href, u2.href);
}

/**
 * Decodes a URI, returning the input when it is malformed.
 * @param url - String to decode.
 * @returns The decoded or original string.
 */
function decodeURISafely(url: string): string {
	try {
		return decodeURI(url);
	} catch {
		return url;
	}
}

/**
 * Compares two strings case-insensitively after URI decoding.
 * @param a - First string.
 * @param b - Second string.
 * @returns -1, 0 or 1.
 */
function alphabeticalComparator(a: string, b: string): number {
	a = decodeURISafely(a.toLowerCase());
	b = decodeURISafely(b.toLowerCase());
	if (a === b) {
		return 0;
	}
	if (a < b) {
		return -1;
	}
	return 1;
}

/**
 * Strips the common leading characters of two strings (case-insensitively).
 * @param t1 - First string.
 * @param t2 - Second string.
 * @returns The lowercased remainders.
 */
function removeMatches(t1: string, t2: string): [string, string] {
	let loopCount = Math.max(t1.length, t2.length);
	t1 = t1.toLowerCase();
	t2 = t2.toLowerCase();
	const a1 = [...t1];
	const a2 = [...t2];
	while (loopCount--) {
		if (a1[0] !== a2[0]) {
			return [a1.join(''), a2.join('')];
		}
		a1.shift();
		a2.shift();
	}
	return ['', ''];
}

/**
 * Compares two strings by the first differing number, else alphabetically.
 * @param t1 - First string.
 * @param t2 - Second string.
 * @returns -1, 0 or 1.
 */
function numericalComparator(t1: string, t2: string): number {
	const [m1, m2] = removeMatches(t1, t2);
	const n1 = Number.parseFloat(m1);
	const n2 = Number.parseFloat(m2);
	if (Number.isFinite(n1) && Number.isFinite(n2)) {
		if (n1 === n2) {
			return 0;
		}
		if (n1 < n2) {
			return -1;
		}
		return 1;
	}
	return alphabeticalComparator(t1, t2);
}

/**
 * Compares two directory segment lists.
 * @param d1 - First segments.
 * @param d2 - Second segments.
 * @returns -1, 0 or 1.
 */
function dirComparator(d1: string[], d2: string[]): number {
	const _d1 = [...d1];
	const _d2 = [...d2];
	while (Math.max(d1.length, d2.length)) {
		let i1 = _d1.shift();
		let i2 = _d2.shift();
		const isDir1 = _d1[0] != null;
		const isDir2 = _d2[0] != null;
		if (i1 == null && i2 == null) {
			return 0;
		}
		if (i1 == null) {
			return -1;
		}
		if (i2 == null) {
			return 1;
		}
		if (i1 === i2) {
			continue;
		}
		if (i1 === '') {
			return -1;
		}
		if (i2 === '') {
			return 1;
		}
		i1 = i1.toLowerCase();
		i2 = i2.toLowerCase();
		const isIndex1 = i1.startsWith('index') || i1 === '';
		const isIndex2 = i2.startsWith('index') || i2 === '';
		if (!isDir1 && !isDir2 && isIndex1 && isIndex2) {
			return 0;
		}
		if (!isDir1 && isIndex1) {
			return -1;
		}
		if (!isDir2 && isIndex2) {
			return 1;
		}
		const r = numericalComparator(i1, i2);
		if (r) {
			return r;
		}
	}
	return 0;
}
