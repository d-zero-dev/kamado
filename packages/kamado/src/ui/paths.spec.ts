import { describe, expect, test } from 'vitest';

import { relativeTo, scrub, showPaths } from './paths.js';

const ROOTS = {
	rootDir: '/home/u/site',
	inputDir: '/home/u/site/src',
	outputDir: '/home/u/site/htdocs',
};

describe('relativeTo', () => {
	test('is relative and written with slashes', () => {
		expect(relativeTo('/home/u/site/src/about/index.html', ROOTS.inputDir)).toBe(
			'about/index.html',
		);
	});
});

describe('showPaths', () => {
	test('the source is told from the input directory and the output from the output directory', () => {
		const page = showPaths(
			{
				url: '/about/',
				inputPath: '/home/u/site/src/about/index.html',
				outputPath: '/home/u/site/htdocs/about/index.html',
			},
			ROOTS,
		);
		expect(page).toEqual({
			url: '/about/',
			inputPath: 'about/index.html',
			outputPath: 'about/index.html',
		});
	});
	test('the reason a value cannot be edited is told without the directories', () => {
		const page = showPaths(
			{
				inputPath: '/home/u/site/src/a.html',
				outputPath: '/home/u/site/htdocs/a.html',
				meta: {
					title: {
						value: 'A',
						reason: 'the front matter of /home/u/site/src/a.html is a flow',
					},
					other: { value: 1 },
				},
			},
			ROOTS,
		);
		expect(page.meta).toEqual({
			title: { value: 'A', reason: 'the front matter of <input>/a.html is a flow' },
			other: { value: 1 },
		});
	});
	test('a source outside the input directory is told by its name only', () => {
		const page = showPaths(
			{ inputPath: '/home/u/elsewhere/a.html', outputPath: '/home/u/site/htdocs/a.html' },
			ROOTS,
		);
		expect(page.inputPath).toBe('a.html');
		expect(relativeTo('/home/u/site/src', ROOTS.inputDir)).toBe('');
	});
	test('a virtual page has no source file', () => {
		expect(
			showPaths(
				{ inputPath: null, outputPath: '/home/u/site/htdocs/v/index.html' },
				ROOTS,
			).inputPath,
		).toBeNull();
	});
});

describe('scrub', () => {
	test('names the directories, the inner one first', () => {
		expect(
			scrub(
				'cannot read /home/u/site/src/a.html and /home/u/site/pages.json (out: /home/u/site/htdocs/x)',
				ROOTS,
			),
		).toBe('cannot read <input>/a.html and <root>/pages.json (out: <output>/x)');
	});
	test('does not take a directory for the start of a longer name', () => {
		expect(scrub('see /home/u/site-old/x.html and /home/u/site/x.html', ROOTS)).toBe(
			'see /home/u/site-old/x.html and <root>/x.html',
		);
	});
	test('a directory with a trailing slash or a character of a pattern is matched as it is', () => {
		const roots = { rootDir: '/a.b+c/', inputDir: '/a.b+c/src', outputDir: '/a.b+c/out' };
		expect(scrub('at /a.b+c/src/x and /axb+c/src/x', roots)).toBe(
			'at <input>/x and /axb+c/src/x',
		);
	});
	test('a directory is not the end of a longer path (the start of the path stays out of it)', () => {
		const roots = { rootDir: '/work', inputDir: '/work/src', outputDir: '/work/out' };
		expect(scrub('cannot read /home/u/work/x and /b/work/y', roots)).toBe(
			'cannot read /home/u/work/x and /b/work/y',
		);
		expect(scrub('cannot read /work/x', roots)).toBe('cannot read <root>/x');
		expect(scrub('(/work) and "/work/src/a"', roots)).toBe('(<root>) and "<input>/a"');
	});
	test('a directory at the end of a sentence is named, one followed by an extension is not', () => {
		expect(scrub('cannot read /home/u/site. Then /home/u/site.bak/x', ROOTS)).toBe(
			'cannot read <root>. Then /home/u/site.bak/x',
		);
	});
	test('leaves a text without any of them', () => {
		expect(scrub('the title is a string', ROOTS)).toBe('the title is a string');
	});
});
