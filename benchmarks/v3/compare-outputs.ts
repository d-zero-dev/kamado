/**
 * CLI for the v2 vs v3 parity harness (see `compare-trees.ts` for the verdicts).
 *
 * Usage: node benchmarks/v3/compare-outputs.ts <baselineDir> <candidateDir> [--json=report.json] [--show=20]
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { compareTrees } from './compare-trees.ts';

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		json: { type: 'string' },
		show: { type: 'string', default: '20' },
	},
});

const [baselineDir, candidateDir] = positionals;
if (!baselineDir || !candidateDir) {
	throw new Error('usage: compare-outputs.ts <baselineDir> <candidateDir>');
}

const { counts, results, ok } = compareTrees(baselineDir, candidateDir);

const total = results.length;
const pct = (n: number) => (total === 0 ? '0.00' : ((n / total) * 100).toFixed(2));

console.log(`files compared: ${total}`);
for (const [verdict, n] of Object.entries(counts)) {
	console.log(`${verdict.padEnd(10)} ${String(n).padStart(8)}  ${pct(n)}%`);
}

const show = Number(values.show);
const problems = results.filter(
	(r) => r.verdict !== 'identical' && r.verdict !== 'smaller',
);
for (const r of problems.slice(0, show)) {
	const sizes =
		r.baselineSize == null ? '' : ` (${r.baselineSize} -> ${r.candidateSize})`;
	console.log(`  ${r.verdict}: ${r.file}${sizes}`);
}
if (problems.length > show) {
	console.log(`  ... and ${problems.length - show} more`);
}

if (values.json) {
	writeFileSync(values.json, JSON.stringify({ counts, results }, null, '\t') + '\n');
}

process.exitCode = ok ? 0 : 1;
