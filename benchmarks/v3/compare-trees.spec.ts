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

	describe('semantic', () => {
		test('without the option a reformatted page is still "different"', () => {
			put(baseline, 'index.html', '<div>\n  <p>x</p>\n</div>');
			put(candidate, 'index.html', '<div><p>x</p></div>');

			const result = compareTrees(baseline, candidate);

			expect(result.results[0]?.verdict).toBe('different');
		});

		test('a page that differs only in formatting is "equivalent" and ok', () => {
			put(baseline, 'index.html', '<div>\n  <p class=a>x&nbsp;y</p>\n</div>');
			put(candidate, 'index.html', '<div><p class="a">x&#160;y</p></div>');
			put(baseline, 'page.htm', '<P>z</P>');
			put(candidate, 'page.htm', '<p>z</p>');

			const result = compareTrees(baseline, candidate, { semantic: true });

			expect(result.results).toEqual([
				{
					file: 'index.html',
					verdict: 'equivalent',
					baselineSize: 38,
					candidateSize: 36,
				},
				{ file: 'page.htm', verdict: 'equivalent', baselineSize: 8, candidateSize: 8 },
			]);
			expect(result.counts.equivalent).toBe(2);
			expect(result.ok).toBe(true);
		});

		test('an equivalent page whose inline code differs lists it and is not ok', () => {
			put(
				baseline,
				'index.html',
				'<p style="color: red">x</p><script>var a = 1;</script>',
			);
			put(candidate, 'index.html', '<p style="color:red">x</p><script>var a=1</script>');

			const result = compareTrees(baseline, candidate, { semantic: true });

			expect(result.results[0]?.verdict).toBe('equivalent');
			expect(result.results[0]?.differs).toEqual(['inline-script', 'inline-style']);
			expect(result.ok).toBe(false);
		});

		test('an equivalent page with a different number of empty class attributes lists it', () => {
			put(baseline, 'index.html', '<ul class=""><li>x</li></ul>');
			put(candidate, 'index.html', '<ul><li>x</li></ul>');

			const result = compareTrees(baseline, candidate, { semantic: true });

			expect(result.results[0]?.differs).toEqual(['empty-class']);
			expect(result.ok).toBe(false);
		});

		test('a page whose markup differs stays "different"', () => {
			put(baseline, 'index.html', '<p>a</p>');
			put(candidate, 'index.html', '<p>b</p>');

			const result = compareTrees(baseline, candidate, { semantic: true });

			expect(result.results[0]?.verdict).toBe('different');
			expect(result.ok).toBe(false);
		});

		test('prefixed declarations found on only one side of a stylesheet are listed', () => {
			put(
				baseline,
				'style.css',
				'a{-webkit-box-decoration-break:clone;box-decoration-break:clone;color:red}',
			);
			put(
				candidate,
				'style.css',
				'a{box-decoration-break:clone;color:red}b{-moz-appearance:none}',
			);

			const result = compareTrees(baseline, candidate, { semantic: true });

			expect(result.results[0]?.verdict).toBe('smaller');
			expect(result.results[0]?.prefixes).toEqual({
				removed: ['a { -webkit-box-decoration-break:clone }'],
				added: ['b { -moz-appearance:none }'],
			});
		});

		test('pages that are not UTF-8 are compared by their bytes', () => {
			// "あ" and "い" in Shift_JIS: as UTF-8 both would decode to U+FFFD.
			const page = (bytes: number[]) =>
				Buffer.concat([Buffer.from('<p>'), Buffer.from(bytes), Buffer.from('</p>')]);
			writeFileSync(path.join(baseline, 'sjis.html'), page([0x82, 0xa0]));
			writeFileSync(path.join(candidate, 'sjis.html'), page([0x82, 0xa2]));
			writeFileSync(path.join(baseline, 'same.html'), page([0x82, 0xa0]));
			writeFileSync(
				path.join(candidate, 'same.html'),
				Buffer.concat([
					Buffer.from('<p>\n'),
					Buffer.from([0x82, 0xa0]),
					Buffer.from('\n</p>'),
				]),
			);

			const result = compareTrees(baseline, candidate, { semantic: true });

			expect(result.results.map((r) => [r.file, r.verdict])).toEqual([
				['same.html', 'equivalent'],
				['sjis.html', 'different'],
			]);
		});

		test('an empty class that moves to another element is listed', () => {
			put(baseline, 'index.html', '<ul class=""><li>x</li></ul><p>y</p>');
			put(candidate, 'index.html', '<ul><li>x</li></ul><p class="">y</p>');

			const result = compareTrees(baseline, candidate, { semantic: true });

			expect(result.results[0]?.differs).toEqual(['empty-class']);
		});

		test('files that are not pages are not normalized', () => {
			put(baseline, 'a.svg', '<svg>\n  <g/>\n</svg>');
			put(candidate, 'a.svg', '<svg><g/></svg>');
			put(baseline, 'a.js', 'a="-webkit-x:1"');
			put(candidate, 'a.js', 'a=1');

			const result = compareTrees(baseline, candidate, { semantic: true });

			expect(result.results).toEqual([
				{ file: 'a.js', verdict: 'smaller', baselineSize: 15, candidateSize: 3 },
				{ file: 'a.svg', verdict: 'different', baselineSize: 19, candidateSize: 15 },
			]);
		});

		test('without the option, stylesheets carry no prefix list and counts no equivalent', () => {
			put(baseline, 'style.css', 'a{-webkit-x:1;color:red}');
			put(candidate, 'style.css', 'a{color:red}');

			const result = compareTrees(baseline, candidate);

			expect(result.results[0]?.prefixes).toBeUndefined();
			expect(Object.keys(result.counts)).toEqual([
				'identical',
				'smaller',
				'larger',
				'different',
				'missing',
				'extra',
			]);
		});

		test('a prefix that only the baseline has is left to check and is not ok', () => {
			put(baseline, 'removed.css', 'a{-webkit-x:1;color:red}');
			put(candidate, 'removed.css', 'a{color:red}');

			expect(compareTrees(baseline, candidate, { semantic: true }).ok).toBe(false);
		});

		test('a prefix that only the candidate has is listed but ok', () => {
			put(baseline, 'added.css', 'a{color:red;margin:0;padding:0}');
			put(candidate, 'added.css', 'a{color:red}b{-ms-x:1}');

			const result = compareTrees(baseline, candidate, { semantic: true });

			expect(result.results[0]?.prefixes?.added).toEqual(['b { -ms-x:1 }']);
			expect(result.ok).toBe(true);
		});

		test('a byte order mark on one side only is a difference', () => {
			writeFileSync(path.join(baseline, 'bom.html'), '﻿<p>x</p>');
			put(candidate, 'bom.html', '<p>\nx\n</p>');

			const result = compareTrees(baseline, candidate, { semantic: true });

			expect(result.results[0]?.verdict).toBe('different');
		});

		test('a stylesheet whose prefixes agree carries no prefix list', () => {
			put(baseline, 'style.css', 'a{color:red;-webkit-x:1}');
			put(candidate, 'style.css', 'a{color:red;-webkit-x:1;}');

			const result = compareTrees(baseline, candidate, { semantic: true });

			expect(result.results[0]?.prefixes).toBeUndefined();
		});
	});
});
