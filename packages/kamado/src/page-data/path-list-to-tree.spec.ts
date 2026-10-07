import type { PathListToTreeOptions } from './path-list-to-tree.js';

import { pathListToTree as sharedPathListToTree } from '@d-zero/shared/path-list-to-tree';
import { pathComparator as sharedPathComparator } from '@d-zero/shared/sort/path';
import { describe, expect, test } from 'vitest';

import { pathComparator, pathListToTree } from './path-list-to-tree.js';
import { createRng, outcome, randomPages, randomUrl } from './random.test-util.js';

const ODD_PATHS = [
	'',
	'mailto:someone@example.com',
	'http://other.example/a/',
	'//host.example/x/',
	'relative/page.html',
	'?q=1',
	'#h',
	'a/../b/',
	'/a//b/',
	'/a/b/../c.html',
	'/%E3%81%82/',
	'/あ/い.html',
	'/a/b.html?x=1#y',
	'/a/index.html?x=1',
	'https://[bad',
	'/ä/',
	'/A/',
	'/a/',
];

describe('pathComparator', () => {
	test('orders random path pairs exactly like @d-zero/shared', () => {
		const rng = createRng(1);
		for (let i = 0; i < 3000; i++) {
			const a = rng.chance(0.1) ? rng.pick(ODD_PATHS) : randomUrl(rng);
			const b = rng.chance(0.1) ? rng.pick(ODD_PATHS) : randomUrl(rng);
			expect(
				outcome(() => pathComparator(a, b)),
				`${a} vs ${b}`,
			).toStrictEqual(outcome(() => sharedPathComparator(a, b)));
		}
	});

	test('throws like @d-zero/shared for strings that cannot be parsed as a URL', () => {
		for (const bad of ['https://[bad']) {
			const expected = outcome(() => sharedPathComparator(bad, '/a/'));
			expect(expected).toHaveProperty('error');
			expect(outcome(() => pathComparator(bad, '/a/'))).toStrictEqual(expected);
		}
	});

	test('sorts whole lists exactly like @d-zero/shared', () => {
		const rng = createRng(2);
		for (let i = 0; i < 200; i++) {
			const list = randomPages(rng, 30).map((page) => page.url);
			list.push(...Array.from({ length: rng.int(0, 3) }, () => rng.pick(ODD_PATHS)));
			expect(outcome(() => list.toSorted(pathComparator))).toStrictEqual(
				outcome(() => list.toSorted(sharedPathComparator)),
			);
		}
	});
});

/**
 * Builds random options for `pathListToTree`.
 * @param rng - Random source.
 * @param list - The path list the options are used with.
 * @returns Options usable by both implementations.
 */
function randomOptions(
	rng: ReturnType<typeof createRng>,
	list: string[],
): PathListToTreeOptions<{ stem: string }> {
	const options: PathListToTreeOptions<{ stem: string }> = {};
	const comparator = rng.int(0, 4);
	if (comparator === 1) options.comparator = 'path';
	if (comparator === 2) options.comparator = null;
	if (comparator === 3) options.comparator = (a, b) => b.localeCompare(a);
	if (rng.chance(0.6)) {
		options.currentPath =
			list.length > 0 && rng.chance(0.8) ? rng.pick(list) : randomUrl(rng);
	}
	if (rng.chance(0.2))
		options.baseUrl = rng.pick(['https://example.org/sub/', 'http://x.test']);
	if (rng.chance(0.3)) options.extensions = rng.pick([['.php'], [' .PDF ', '.htm'], []]);
	if (rng.chance(0.3)) {
		options.ignoreGlobs = rng.pick([
			['/a/**'],
			['**/*.htm', '/b/*'],
			['**/c/**'],
			['/*'],
		]);
	}
	if (rng.chance(0.3)) options.createVirtualParent = rng.chance(0.3);
	if (rng.chance(0.3)) options.filter = (node) => !node.url.includes('b');
	if (rng.chance(0.5)) options.addMetaData = (node) => ({ stem: node.stem + node.depth });
	return options;
}

describe('pathListToTree', () => {
	test('builds the same tree (or throws the same error) as @d-zero/shared over random inputs', () => {
		const rng = createRng(3);
		let errors = 0;
		let virtual = 0;
		for (let i = 0; i < 1500; i++) {
			const list = randomPages(rng, 12).map((page) => page.url);
			if (rng.chance(0.15)) {
				list.push(...Array.from({ length: rng.int(1, 3) }, () => rng.pick(ODD_PATHS)));
			}
			const options = randomOptions(rng, list);
			const actual = outcome(() => pathListToTree([...list], options));
			const expected = outcome(() => sharedPathListToTree([...list], options));
			expect(actual, `case ${i}: ${JSON.stringify(list)}`).toStrictEqual(expected);
			if ('error' in actual) errors++;
			else if (JSON.stringify(actual.value).includes('"virtual"')) virtual++;
		}
		// The generator must exercise both the error paths and virtual parents.
		expect(errors).toBeGreaterThan(20);
		expect(virtual).toBeGreaterThan(100);
	});

	test('reports a missing root and a missing parent like @d-zero/shared', () => {
		expect(outcome(() => pathListToTree([]))).toStrictEqual(
			outcome(() => sharedPathListToTree([])),
		);
		expect(outcome(() => pathListToTree([]))).toStrictEqual({
			error: { name: 'Error', message: 'Root node not found' },
		});
		const options = { createVirtualParent: false };
		expect(outcome(() => pathListToTree(['/', '/a/b.html'], options))).toStrictEqual({
			error: { name: 'Error', message: 'Parent node not found: "/a/"' },
		});
		expect(
			outcome(() => sharedPathListToTree(['/', '/a/b.html'], options)),
		).toStrictEqual({
			error: { name: 'Error', message: 'Parent node not found: "/a/"' },
		});
	});

	test('marks virtual parents and ancestors of the current page', () => {
		const tree = pathListToTree(['/', '/a/b/c.html'], { currentPath: '/a/b/c.html' });
		expect(tree.children[0]).toMatchObject({
			url: '/a/',
			stem: '/a/',
			depth: 1,
			current: false,
			isAncestor: true,
			virtual: true,
		});
		expect(tree.children[0]!.children[0]!.children[0]).toMatchObject({
			url: '/a/b/c.html',
			stem: '/a/b/c',
			depth: 3,
			current: true,
			isAncestor: false,
		});
	});
});
