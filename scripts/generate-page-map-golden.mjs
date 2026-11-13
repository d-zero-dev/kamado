/**
 * Writes `crates/kd_site/tests/page_map_golden.tsv`: for page URLs, the `depth` and the
 * `parent` that `kamado pages` writes (RFC §14.1). The numbers are the ones the tree of
 * the navigation (`pathListToTree`, `packages/kamado/src/page-data/path-list-to-tree.ts`)
 * gives the page, so that the map and `nav()` count the same way: each URL is put into a
 * tree together with the directories above it, and the depth of its node and the URL of
 * the node it hangs from are read back.
 *
 * What it checks is which node is the page's parent and how deep the page is, for URLs the
 * tree and the string agree on. The parent's URL is the URL of the directory, built here from
 * the page's own URL, so how a parent is written (no percent-encoding again) is the rule of
 * `kamado pages`, not something the tree confirms. File names with `?`, `#` or `\` are left out:
 * the tree reads those as parts of a URL and `kamado pages` as part of a name (RFC §14.1).
 *
 * Each line is `url<TAB>depth<TAB>parent`; the parent of the root is empty. The URLs are
 * the hand-written ones below and the ones the random generator of the differential specs
 * of the page data (`random.test-util.ts`) makes from a fixed seed.
 *
 * `crates/kd_site/tests/page_map_golden.rs` checks `kd_site::url_depth_and_parent` against
 * the file; `scripts/generate-page-map-golden.spec.ts` fails while the committed file is not
 * what this writes. Run it when `path-list-to-tree.ts` or the generator of URLs changes:
 * `node scripts/generate-page-map-golden.mjs`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { pathListToTree } from '../packages/kamado/src/page-data/path-list-to-tree.ts';
import {
	createRng,
	randomUrl,
} from '../packages/kamado/src/page-data/random.test-util.ts';

import { isMain } from './is-main.mjs';

const root = path.resolve(import.meta.dirname, '..');

/** Where the golden is written. */
export const GOLDEN_FILE = path.join(
	root,
	'crates',
	'kd_site',
	'tests',
	'page_map_golden.tsv',
);

/** The seed of the random URLs. */
const SEED = 387;

/** How many random URLs. */
const RANDOM_COUNT = 500;

/**
 * URLs worth having whatever the generator makes: the root, a directory, a file, an
 * `index` in every spelling the tree knows, and the forms of `pages.outputExtension: ""`.
 */
const FIXED = [
	'/',
	'/index.html',
	'/a/',
	'/a.html',
	'/a/b/',
	'/a/b.html',
	'/a/index.html',
	'/a/index.htm',
	'/a/INDEX.html',
	'/a/Index.HTML',
	'/a/index.php',
	'/a/index.old.html',
	'/a/index-old/',
	'/a/b/c/',
	'/a/b/c/d.html',
	'/a/b/c/index.html',
	'/about/history/',
	'/about/history.html',
	'/a%20b/c%20d.html',
	'/x y/page.html',
	'/a',
	'/a/b',
	'/a/index',
	'/index',
	// The tree reads a run of `/` as one, and does not decode `%69`: `%69ndex` is not `index`.
	// The case of a letter is the one `toLowerCase` gives, whatever it is: `İ` is not an `i`.
	'/a//b.html',
	'/a//',
	'/a/b//c.html',
	'/a/%69ndex.html',
	'/a/%69ndex/',
	'/a/İndex.html',
];

/** Every extension the URLs above and the generator write, besides `.html` and `.htm`. */
const EXTENSIONS = ['.pdf', '.php'];

/**
 * The URLs of the directories above a page, from the root down. A run of `/` counts as one,
 * as the tree reads it.
 * @param {string} url - The URL of a page
 * @returns {string[]} `['/', '/a/', '/a/b/']` for `/a/b/c.html`
 * @example
 * directoriesAbove('/a/b/c.html'); // ['/', '/a/', '/a/b/']
 * directoriesAbove('/a//b.html'); // ['/', '/a/']
 */
export function directoriesAbove(url) {
	const segments = url
		.split('/')
		.slice(1, -1)
		.filter((segment) => segment !== '');
	const urls = ['/'];
	for (let i = 1; i <= segments.length; i++) {
		urls.push(`/${segments.slice(0, i).join('/')}/`);
	}
	return urls;
}

/**
 * The node of `url` in a tree made of the directories above it and the page, with the
 * node it hangs from.
 * @param {string} url - The URL of a page
 * @returns {{ depth: number, parent: string | null }} What `pathListToTree` gives the page
 * @example
 * treeOf('/a/b.html'); // { depth: 2, parent: '/a/' }
 */
export function treeOf(url) {
	const tree = pathListToTree([...directoriesAbove(url), url], {
		comparator: null,
		extensions: EXTENSIONS,
	});
	/**
	 * @param {import('../packages/kamado/src/page-data/path-list-to-tree.ts').Node} node
	 * @param {import('../packages/kamado/src/page-data/path-list-to-tree.ts').Node | null} parent
	 * @returns {{ depth: number, parent: string | null } | null}
	 */
	const find = (node, parent) => {
		if (node.url === url) {
			return { depth: node.depth, parent: parent ? parent.url : null };
		}
		for (const child of node.children) {
			const found = find(child, node);
			if (found) {
				return found;
			}
		}
		return null;
	};
	const found = find(tree, null);
	if (!found) {
		throw new Error(`${url} is not in its own tree`);
	}
	return found;
}

/**
 * The URLs of the golden: the fixed ones, then the random ones that are new.
 * @returns {string[]} The URLs, each once
 * @example
 * urls()[0]; // '/'
 */
export function urls() {
	const rng = createRng(SEED);
	const seen = new Set(FIXED);
	const list = [...FIXED];
	for (let i = 0; i < RANDOM_COUNT; i++) {
		const url = randomUrl(rng);
		if (!seen.has(url)) {
			seen.add(url);
			list.push(url);
		}
	}
	return list;
}

/**
 * The text of the golden file.
 * @returns {string} A line `url<TAB>depth<TAB>parent` for each URL
 * @example
 * render().split('\n')[0]; // '/\t0\t'
 */
export function render() {
	return `${urls()
		.map((url) => {
			const { depth, parent } = treeOf(url);
			return `${url}\t${depth}\t${parent ?? ''}`;
		})
		.join('\n')}\n`;
}

if (isMain(import.meta.filename)) {
	mkdirSync(path.dirname(GOLDEN_FILE), { recursive: true });
	writeFileSync(GOLDEN_FILE, render());
}
