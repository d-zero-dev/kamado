import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import {
	directoriesAbove,
	GOLDEN_FILE,
	render,
	treeOf,
	urls,
} from './generate-page-map-golden.mjs';

describe('generate-page-map-golden', () => {
	test('page_map_golden.tsv is what the generator writes', () => {
		// If this fails after path-list-to-tree.ts or random.test-util.ts changed:
		// node scripts/generate-page-map-golden.mjs
		expect(render()).toBe(readFileSync(GOLDEN_FILE, 'utf8'));
	});

	test('the URLs are each once, the root first, and enough of them', () => {
		const list = urls();
		expect(list[0]).toBe('/');
		expect(new Set(list).size).toBe(list.length);
		expect(list.length).toBeGreaterThan(300);
	});

	test('the directories above a page run from the root down', () => {
		expect(directoriesAbove('/')).toEqual(['/']);
		expect(directoriesAbove('/a.html')).toEqual(['/']);
		expect(directoriesAbove('/a/b/c.html')).toEqual(['/', '/a/', '/a/b/']);
		expect(directoriesAbove('/a/b/')).toEqual(['/', '/a/', '/a/b/']);
		// A run of `/` counts as one, as the tree reads it.
		expect(directoriesAbove('/a//b.html')).toEqual(['/', '/a/']);
	});

	test('the tree gives the depth of the page and the directory it hangs from', () => {
		expect(treeOf('/')).toEqual({ depth: 0, parent: null });
		expect(treeOf('/a/b.html')).toEqual({ depth: 2, parent: '/a/' });
		expect(treeOf('/a/b/')).toEqual({ depth: 2, parent: '/a/' });
		// The index of a directory is the directory: it hangs from the one above.
		expect(treeOf('/a/INDEX.html')).toEqual({ depth: 1, parent: '/' });
	});
});
