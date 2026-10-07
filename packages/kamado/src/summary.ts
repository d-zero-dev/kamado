import type { BuildReport } from './build.js';

import { styleText } from 'node:util';

/**
 * Formats a build report for the terminal: one line per page and asset when
 * verbose, the warnings, then the totals by status (pages and assets counted
 * together).
 * @param report - The build report
 * @param verbose - Whether to list every page
 * @returns The text to print
 * @example
 * ```ts
 * console.log(summarize(report, false));
 * // Build completed in 0.42s (120 built, 3 cached)
 * ```
 */
export function summarize(report: BuildReport, verbose: boolean): string {
	const counts = new Map<string, number>();
	for (const { status } of [...report.pages, ...report.assets]) {
		counts.set(status, (counts.get(status) ?? 0) + 1);
	}
	const parts = [...counts.entries()].map(([status, n]) => `${n} ${status}`);
	const lines: string[] = [];
	if (verbose) {
		for (const page of report.pages) {
			lines.push(`  ${styleText('dim', page.status.padEnd(9))} ${page.url}`);
		}
		for (const asset of report.assets) {
			lines.push(`  ${styleText('dim', asset.status.padEnd(9))} ${asset.outputPath}`);
		}
	}
	for (const warning of report.warnings) {
		lines.push(styleText('yellow', `warning: ${warning}`));
	}
	lines.push(
		styleText('green', `Build completed in ${(report.elapsedMs / 1000).toFixed(2)}s`) +
			` (${parts.join(', ')})`,
	);
	return lines.join('\n');
}
