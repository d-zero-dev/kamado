/**
 * CLI for the v2 vs v3 parity harness (see `compare-trees.ts` for the verdicts).
 *
 * Usage: node benchmarks/v3/compare-outputs.ts <baselineDir> <candidateDir> [--json=report.json] [--show=20] [--semantic] [--diff=<file>]
 *
 * - `--semantic`: compare pages by their normalized markup (`html-normalize.ts`), for
 *   checking a migration from v2. Also counts what is left to check on equivalent
 *   pages, lists the prefixed declarations that only one stylesheet has, and, when the
 *   empty `class` attributes differ, the candidate's selectors that test the class
 *   attribute. `--show` bounds each of these lists
 * - `--diff=<file>`: print how one page (a path relative to both directories) differs
 *   after normalizing: its markup, then the inline scripts and styles and the empty
 *   `class` attributes that the comparison sets aside, and nothing else. Exits 0 when
 *   nothing differs, 1 when something does, and 2 when the file is not a page or is
 *   missing on one side
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
	comparePages,
	compareTrees,
	decodePair,
	PAGE,
	type Difference,
} from './compare-trees.ts';
import { classAttributeSelectors } from './css-declarations.ts';
import { normalizeHtml } from './html-normalize.ts';
import { lineDiff } from './line-diff.ts';

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		json: { type: 'string' },
		show: { type: 'string', default: '20' },
		semantic: { type: 'boolean', default: false },
		diff: { type: 'string' },
	},
});

const [baselineDir, candidateDir] = positionals;
if (!baselineDir || !candidateDir) {
	throw new Error('usage: compare-outputs.ts <baselineDir> <candidateDir>');
}

if (values.diff !== undefined) {
	process.exit(diff(values.diff));
}

const show = Number(values.show);
// Prints at most `--show` lines of a list, then how many were left out.
const printBounded = (lines: readonly string[]) => {
	for (const line of lines.slice(0, show)) {
		console.log(line);
	}
	if (lines.length > show) {
		console.log(`  ... and ${lines.length - show} more`);
	}
};

const semantic = values.semantic;
const { counts, results, ok } = compareTrees(baselineDir, candidateDir, { semantic });

const total = results.length;
const pct = (n: number) => (total === 0 ? '0.00' : ((n / total) * 100).toFixed(2));

console.log(`files compared: ${total}`);
for (const [verdict, n] of Object.entries(counts)) {
	console.log(`${verdict.padEnd(10)} ${String(n).padStart(8)}  ${pct(n)}%`);
}

const kinds = new Map<Difference, number>();
for (const r of results) {
	for (const kind of r.differs ?? []) {
		kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
	}
}
if (kinds.size > 0) {
	console.log('equivalent pages left to check:');
	for (const [kind, n] of kinds) {
		console.log(`  ${kind.padEnd(14)} ${n}`);
	}
}

printBounded(
	results
		.filter(
			(r) =>
				(r.verdict !== 'identical' &&
					r.verdict !== 'smaller' &&
					r.verdict !== 'equivalent') ||
				r.differs !== undefined,
		)
		.map((r) => {
			const sizes =
				r.baselineSize == null ? '' : ` (${r.baselineSize} -> ${r.candidateSize})`;
			const label = r.differs ? `${r.verdict} (${r.differs.join(', ')})` : r.verdict;
			return `  ${label}: ${r.file}${sizes}`;
		}),
);

for (const r of results) {
	if (r.prefixes) {
		console.log(`prefixes: ${r.file}`);
		printBounded([
			...r.prefixes.removed.map((declaration) => `  - ${declaration}`),
			...r.prefixes.added.map((declaration) => `  + ${declaration}`),
		]);
	}
}

if (kinds.has('empty-class')) {
	// `class=""` matches these and a missing attribute does not, so they decide whether
	// an empty class attribute that appears or disappears can change the rendering. The
	// stylesheets are the CSS files and the `<style>` of the pages whose empty classes
	// differ: a page's own `<style>` applies to no other page.
	// Files are read as the comparison read them (`decodePair`), and the candidate's
	// files are the results that are not missing from it.
	const read = (file: string) =>
		decodePair(
			readFileSync(path.join(baselineDir, file)),
			readFileSync(path.join(candidateDir, file)),
		)[1];
	const sheets: string[] = [];
	for (const r of results) {
		if (r.verdict === 'missing') {
			continue;
		}
		if (path.extname(r.file) === '.css') {
			const bytes = readFileSync(path.join(candidateDir, r.file));
			sheets.push(decodePair(bytes, bytes)[1]);
		} else if (r.differs?.includes('empty-class')) {
			sheets.push(...normalizeHtml(read(r.file)).inline.styles);
		}
	}
	const selectors = new Set<string>();
	for (const sheet of sheets) {
		for (const selector of classAttributeSelectors(sheet)) {
			selectors.add(selector);
		}
	}
	console.log(`selectors that test the class attribute: ${selectors.size}`);
	printBounded([...selectors].map((selector) => `  ${selector}`));
}

if (values.json) {
	writeFileSync(values.json, JSON.stringify({ counts, results }, null, '\t') + '\n');
}

process.exitCode = ok ? 0 : 1;

// `--diff`: prints how one page differs after normalizing and returns the exit code.
/**
 *
 * @param file
 */
function diff(file: string): number {
	if (!PAGE.has(path.extname(file))) {
		console.error(`--diff compares pages (.html, .htm): ${file}`);
		return 2;
	}
	const sides = [
		['baseline', path.join(baselineDir!, file)],
		['candidate', path.join(candidateDir!, file)],
	] as const;
	for (const [side, full] of sides) {
		if (!existsSync(full)) {
			console.error(`${file} is not in the ${side} (${full})`);
			return 2;
		}
	}
	const page = comparePages(
		...decodePair(readFileSync(sides[0][1]), readFileSync(sides[1][1])),
	);
	const { baseline: a, candidate: b } = page;
	console.log(
		page.sameMarkup
			? 'the normalized markup is the same'
			: lineDiff(a.markup.split('\n'), b.markup.split('\n')).join('\n'),
	);
	// What the comparison sets aside, so that an `equivalent` page can be checked too.
	const details: Readonly<Record<Difference, () => string>> = {
		'inline-script': () =>
			`inline scripts:\n${lineDiff(a.inline.scripts, b.inline.scripts, 0).join('\n')}`,
		'inline-style': () =>
			`inline styles:\n${lineDiff(a.inline.styles, b.inline.styles, 0).join('\n')}`,
		'empty-class': () => {
			const list = (tags: readonly number[]) =>
				tags.length > 0 ? tags.join(', ') : '(none)';
			return `empty class attributes on start tags: ${list(a.emptyClass)} -> ${list(b.emptyClass)}`;
		},
	};
	for (const kind of page.differs) {
		console.log(details[kind]());
	}
	return page.sameMarkup && page.differs.length === 0 ? 0 : 1;
}
