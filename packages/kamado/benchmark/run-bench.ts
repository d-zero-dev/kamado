/* eslint-disable import-x/no-extraneous-dependencies -- dev-only benchmark; imports sibling workspace packages that depend on kamado */
/**
 * Build benchmark runner.
 *
 * Generates a synthetic site (see generate-fixtures.ts) and measures `build()`
 * wall-clock time. Runs against the built dist of each package — run
 * `yarn build` before benchmarking.
 *
 * Usage:
 *   yarn bench [--pages=1000] [--runs=3] [--full]
 *
 * --full enables the default page transforms (jsdom/prettier/minifier), which
 * dominate CPU time. By default transforms are disabled to isolate the
 * compile/IO pipeline.
 */
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { createPageCompiler } from '@kamado-io/page-compiler';
import { createCompileHooks } from '@kamado-io/pug-compiler';
import { createScriptCompiler } from '@kamado-io/script-compiler';
import { createStyleCompiler } from '@kamado-io/style-compiler';

import { generateFixtures } from './generate-fixtures.ts';

import { build } from 'kamado/build';
import { clearBuildCaches } from 'kamado/data';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = path.resolve(__dirname, '..', '.bench');

/**
 * Reads a positive integer CLI argument; non-numeric or non-positive values
 * fall back so the benchmark never runs with 0 pages or 0 runs (which would
 * silently report meaningless numbers like Infinity pages/s)
 * @param name
 * @param fallback
 */
function readArg(name: string, fallback: number): number {
	const raw = process.argv.find((argument) => argument.startsWith(`--${name}=`));
	if (!raw) {
		return fallback;
	}
	const value = Number.parseInt(raw.split('=')[1] ?? '', 10);
	return Number.isNaN(value) || value < 1 ? fallback : value;
}

const pageCount = readArg('pages', 1000);
const runCount = readArg('runs', 3);
const useFullTransforms = process.argv.includes('--full');

const fixtures = await generateFixtures(BENCH_DIR, pageCount);

const durations: number[] = [];

for (let run = 0; run < runCount; run++) {
	// Reset module-level caches so each run measures a cold build
	clearBuildCaches();

	const start = performance.now();
	await build({
		// @ts-expect-error -- pkg is accepted by mergeConfig to skip package.json lookup
		pkg: { name: 'kamado-bench', version: '0.0.0' },
		rootDir: fixtures.rootDir,
		dir: {
			input: fixtures.inputDir,
			output: fixtures.outputDir,
		},
		compilers: (def) => [
			def(createPageCompiler(), {
				files: '**/*.pug',
				compileHooks: createCompileHooks({
					basedir: fixtures.rootDir,
				}),
				layouts: { dir: fixtures.layoutsDir },
				globalData: { dir: fixtures.dataDir },
				...(useFullTransforms ? {} : { transforms: [] }),
			}),
			def(createStyleCompiler(), {}),
			def(createScriptCompiler(), {}),
		],
	});
	const duration = performance.now() - start;
	durations.push(duration);
}

durations.sort((a, b) => a - b);
const middle = Math.floor(durations.length / 2);
const median =
	durations.length % 2 === 0
		? ((durations[middle - 1] ?? 0) + (durations[middle] ?? 0)) / 2
		: (durations[middle] ?? 0);
const fastest = durations[0] ?? 0;
const slowest = durations.at(-1) ?? 0;

console.log('');
console.log('=== kamado build benchmark ===');
console.log(
	`pages: ${pageCount}, runs: ${runCount}, transforms: ${useFullTransforms ? 'default' : 'none'}`,
);
console.log(
	`median:  ${(median / 1000).toFixed(2)}s (${(pageCount / (median / 1000)).toFixed(1)} pages/s)`,
);
console.log(`fastest: ${(fastest / 1000).toFixed(2)}s`);
console.log(`slowest: ${(slowest / 1000).toFixed(2)}s`);
console.log(`rss: ${(process.memoryUsage().rss / 1024 / 1024).toFixed(0)} MB`);
