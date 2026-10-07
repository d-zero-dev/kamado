/**
 * Builds a JSX fixture (`generate-jsx-fixtures.ts --target=v2`) with kamado v2:
 * the baseline of the v2 vs v3 parity harness. Only pages are built (the
 * comparison is of HTML), with the page options v3 defaults to: tabs,
 * `bracketSameLine`, no print width limit, and the code minifiers off (v3
 * compares the code of `<script>` / `<style>` separately).
 *
 * Runs against the published packages that `benchmarks/v2-baseline/package.json` pins, so
 * nothing has to be built first.
 *
 * Usage: node benchmarks/v2-baseline/run.ts <fixtureDir> [--out=<dir>]
 */
import path from 'node:path';
import { parseArgs } from 'node:util';

import { createCompileHooks } from '@kamado-io/jsx-compiler';
import {
	createPageCompiler,
	doctype,
	lineBreak,
	manipulateDOM,
	minifier,
	prettier,
} from '@kamado-io/page-compiler';
import { build } from 'kamado/build';

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: { out: { type: 'string' } },
});
const [fixtureDir] = positionals;
if (!fixtureDir) {
	throw new Error('usage: run.ts <fixtureDir> [--out=<dir>]');
}
const rootDir = path.resolve(fixtureDir);
const outDir = path.resolve(values.out ?? path.join(rootDir, 'output-v2'));

await build({
	// @ts-expect-error -- pkg is accepted by mergeConfig to skip package.json lookup
	pkg: { name: 'bench', version: '0.0.0', production: { siteName: 'Bench' } },
	rootDir,
	dir: { input: path.join(rootDir, 'input'), output: outDir },
	compilers: (def) => [
		def(createPageCompiler(), {
			files: 'pages/**/*.tsx',
			compileHooks: createCompileHooks(),
			layouts: { dir: path.join(rootDir, 'input', '_libs', 'layouts') },
			globalData: { dir: path.join(rootDir, 'input', '_libs', 'data') },
			transforms: () => [
				manipulateDOM({ imageSizes: true }),
				doctype(),
				prettier({
					options: { useTabs: true, bracketSameLine: true, printWidth: 100_000 },
				}),
				minifier({ options: { minifyCSS: false, minifyJS: false } }),
				lineBreak(),
			],
		}),
	],
});
console.log(`v2 built ${rootDir} -> ${outDir}`);
