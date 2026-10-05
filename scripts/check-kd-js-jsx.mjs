/**
 * Differential check of the v3 JSX path against v2's: each TSX case is
 * compiled by `kd_js` and rendered by the v3 runtime, and bundled by esbuild
 * and rendered by React 19 `renderToStaticMarkup` (what `@kamado-io/jsx-compiler`
 * did). The two strings are compared as they are.
 *
 * ```sh
 * cargo build --release --offline -p kd_js --example compile
 * node scripts/check-kd-js-jsx.mjs            # the hand-written cases
 * node scripts/check-kd-js-jsx.mjs fuzz 2000 1  # random components
 * ```
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildSync } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { cases as handWritten } from './jsx-cases.mjs';

const root = path.resolve(import.meta.dirname, '..');
const binary = path.join(root, 'target', 'release', 'examples', 'compile');
const work = path.join(process.env.TMPDIR ?? '/tmp', `kd-jsx-check-${process.pid}`);

/** @type {{ name: string; source: string; props?: Record<string, unknown> }[]} */
let cases = handWritten;
if (process.argv[2] === 'fuzz') {
	const { createCaseGenerator } = await import('./jsx-fuzz.mjs');
	const next = createCaseGenerator(Number(process.argv[4] ?? 1));
	cases = Array.from({ length: Number(process.argv[3] ?? 500) }, next);
}

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
// The runtime is TypeScript with `.js` import specifiers (tsc's convention),
// which Node cannot load from source; bundle it for the check.
const runtimeFile = path.join(work, 'runtime.mjs');
buildSync({
	entryPoints: [path.join(root, 'packages', 'kamado-v3', 'src', 'jsx', 'runtime.ts')],
	bundle: true,
	format: 'esm',
	platform: 'node',
	outfile: runtimeFile,
	logLevel: 'silent',
});
const runtime = pathToFileURL(runtimeFile).href;
const files = cases.map((c, i) => {
	const file = path.join(work, `case${i}.tsx`);
	writeFileSync(file, c.source);
	return file;
});

const run = spawnSync(binary, [], {
	input: files.join('\n') + '\n',
	encoding: 'utf8',
	maxBuffer: 1 << 30,
	env: { ...process.env, KD_JS_RUNTIME: runtime },
});
if (run.status !== 0) {
	throw new Error(`compile example failed: ${run.stderr}`);
}
const compiled = new Map(
	run.stdout
		.split('\n')
		.filter(Boolean)
		.map((line) => {
			const r = JSON.parse(line);
			return [r.path, r];
		}),
);

const { render } = await import(runtime);

let same = 0;
const problems = [];
for (const [i, c] of cases.entries()) {
	const file = files[i];
	let expected;
	try {
		const bundle = buildSync({
			stdin: { contents: c.source, loader: 'tsx', resolveDir: root, sourcefile: file },
			bundle: true,
			format: 'esm',
			platform: 'node',
			jsx: 'automatic',
			write: false,
			logLevel: 'silent',
		}).outputFiles[0].text;
		const oracleFile = path.join(work, `oracle${i}.mjs`);
		writeFileSync(oracleFile, bundle);
		const mod = await import(pathToFileURL(oracleFile).href);
		expected = renderToStaticMarkup(createElement(mod.default, c.props ?? {}));
	} catch (error) {
		expected = `__ERROR__ ${String(error.message).split('\n')[0]}`;
	}
	let actual;
	const result = compiled.get(file);
	if (result.error) {
		actual = `__COMPILE_ERROR__ ${result.error}`;
	} else {
		try {
			const outFile = path.join(work, `case${i}.mjs`);
			writeFileSync(outFile, result.code);
			const mod = await import(pathToFileURL(outFile).href);
			actual = render(mod.default, c.props ?? {});
		} catch (error) {
			actual = `__ERROR__ ${String(error.message).split('\n')[0]}`;
		}
	}
	if (actual === expected) {
		same++;
	} else if (expected.startsWith('__ERROR__') && /^__(?:COMPILE_)?ERROR__/.test(actual)) {
		same++;
	} else {
		problems.push(
			`--- ${c.name}\n${c.source}\n  props: ${JSON.stringify(c.props ?? {})}\n  expected: ${expected}\n  actual:   ${actual}\n`,
		);
	}
}
for (const p of problems.slice(0, 40)) {
	process.stdout.write(`${p}\n`);
}
process.stdout.write(
	`${same} same, ${problems.length} differ, of ${cases.length} cases\n`,
);
rmSync(work, { recursive: true, force: true });
process.exit(problems.length > 0 ? 1 : 0);
