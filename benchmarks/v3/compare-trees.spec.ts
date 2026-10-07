import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { compareTrees } from './compare-trees.ts';

describe('compareTrees', () => {
	let root: string;
	let baseline: string;
	let candidate: string;

	const put = (dir: string, rel: string, content: string) => {
		const file = path.join(dir, rel);
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, content);
	};

	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), 'kamado-compare-'));
		baseline = path.join(root, 'baseline');
		candidate = path.join(root, 'candidate');
		mkdirSync(baseline);
		mkdirSync(candidate);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test('byte-equal files are identical and the comparison is ok', () => {
		put(baseline, 'a/index.html', '<p>x</p>');
		put(candidate, 'a/index.html', '<p>x</p>');

		const result = compareTrees(baseline, candidate);

		expect(result.counts.identical).toBe(1);
		expect(result.ok).toBe(true);
	});

	test('a differing html file is "different" even when the size is equal', () => {
		put(baseline, 'index.html', '<p>a</p>');
		put(candidate, 'index.html', '<p>b</p>');

		const result = compareTrees(baseline, candidate);

		expect(result.results).toEqual([
			{ file: 'index.html', verdict: 'different', baselineSize: 8, candidateSize: 8 },
		]);
		expect(result.ok).toBe(false);
	});

	test.each([
		['.css', 'a{color:red}', 'a{color:red;}', 'larger', false],
		['.css', 'a{color:red;}', 'a{color:red}', 'smaller', true],
		['.js', 'var a = 1;', 'var a=1', 'smaller', true],
		['.map', '{"v":3}', '{"v":3,"x":1}', 'larger', false],
	] as const)(
		'%s files that differ are judged by size only (%s -> %s is %s)',
		(ext, before, after, verdict, ok) => {
			put(baseline, `file${ext}`, before);
			put(candidate, `file${ext}`, after);

			const result = compareTrees(baseline, candidate);

			expect(result.results[0]?.verdict).toBe(verdict);
			expect(result.ok).toBe(ok);
		},
	);

	test('a file only in the baseline is "missing" and only in the candidate is "extra"', () => {
		put(baseline, 'only-v2.html', 'a');
		put(candidate, 'only-v3.html', 'b');

		const result = compareTrees(baseline, candidate);

		expect(result.results).toEqual([
			{ file: 'only-v2.html', verdict: 'missing' },
			{ file: 'only-v3.html', verdict: 'extra' },
		]);
		expect(result.ok).toBe(false);
	});

	test('two empty trees are not ok: nothing was compared', () => {
		const result = compareTrees(baseline, candidate);

		expect(result.results).toEqual([]);
		expect(result.ok).toBe(false);
	});

	test('nested directories are walked and paths are relative', () => {
		put(baseline, 'a/b/c/deep.html', 'x');
		put(candidate, 'a/b/c/deep.html', 'x');

		expect(compareTrees(baseline, candidate).results[0]?.file).toBe(
			path.join('a', 'b', 'c', 'deep.html'),
		);
	});
});
