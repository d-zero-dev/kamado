import type { BuildReport } from './build.js';

import { describe, expect, test } from 'vitest';

import { summarize } from './summary.js';

const report: BuildReport = {
	version: 1,
	pages: [
		{
			url: '/',
			inputPath: '/s/index.html',
			outputPath: '/o/index.html',
			status: 'built',
			meta: {},
		},
		{
			url: '/a/',
			inputPath: '/s/a/index.html',
			outputPath: '/o/a/index.html',
			status: 'cached',
			meta: {},
		},
		{
			url: '/b/',
			inputPath: '/s/b/index.html',
			outputPath: '/o/b/index.html',
			status: 'built',
			meta: {},
		},
	],
	assets: [],
	warnings: [],
	elapsedMs: 1234,
};

/**
 * Removes ANSI escape sequences so assertions read as plain text.
 * @param text - Terminal text
 */
function plain(text: string): string {
	// eslint-disable-next-line no-control-regex -- matching ANSI escapes is the point
	return text.replaceAll(/\u001B\[[\d;]*m/g, '');
}

describe('summarize', () => {
	test('prints the elapsed time in seconds and the totals by status', () => {
		expect(plain(summarize(report, false))).toBe(
			'Build completed in 1.23s (2 built, 1 cached)',
		);
	});

	test('lists every page with its status when verbose', () => {
		expect(plain(summarize(report, true)).split('\n')).toEqual([
			'  built     /',
			'  cached    /a/',
			'  built     /b/',
			'Build completed in 1.23s (2 built, 1 cached)',
		]);
	});

	test('prints warnings before the totals', () => {
		const withWarning: BuildReport = {
			...report,
			warnings: ["Output path collision: '/o/a.html'"],
		};
		expect(plain(summarize(withWarning, false)).split('\n')).toEqual([
			"warning: Output path collision: '/o/a.html'",
			'Build completed in 1.23s (2 built, 1 cached)',
		]);
	});

	test('an empty site reports zero pages without a status list', () => {
		expect(
			plain(
				summarize(
					{ version: 1, pages: [], assets: [], warnings: [], elapsedMs: 0 },
					false,
				),
			),
		).toBe('Build completed in 0.00s ()');
	});

	test('assets are counted with the pages and listed by output path when verbose', () => {
		const withAssets: BuildReport = {
			...report,
			assets: [
				{
					kind: 'script',
					inputPath: '/s/js/app.ts',
					outputPath: '/o/js/app.js',
					status: 'built',
				},
				{
					kind: 'style',
					inputPath: '/s/css/a.css',
					outputPath: '/o/css/a.css',
					status: 'cached',
				},
			],
		};
		expect(plain(summarize(withAssets, false))).toBe(
			'Build completed in 1.23s (3 built, 2 cached)',
		);
		expect(plain(summarize(withAssets, true)).split('\n').slice(3, 5)).toEqual([
			'  built     /o/js/app.js',
			'  cached    /o/css/a.css',
		]);
	});
});
