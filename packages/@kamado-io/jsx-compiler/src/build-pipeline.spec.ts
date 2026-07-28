import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import {
	describe,
	test,
	expect,
	beforeAll,
	afterAll,
	beforeEach,
	afterEach,
} from 'vitest';

import { runNodeScript } from './test-support/run-node-script.js';

/**
 * Real-FS integration test: runs the full build() pipeline
 * (kamado core → page-compiler → jsx-compiler) with a shared layout that
 * imports a shared component, and asserts the written HTML output.
 *
 * build() must run in a real Node.js child process — see
 * run-compile-jsx-script.ts for why (module.registerHooks() virtual modules
 * cannot be import()ed from inside vitest's own module runner). Fixture
 * sites live under this package's own .kamado/test-tmp/ (gitignored)
 * instead of os.tmpdir(), because rendering a component resolves the bare
 * `react`/`react-dom` specifiers by walking up from resolveDir looking for
 * node_modules — os.tmpdir() has none above it.
 */

const createCompileHooksModuleUrl = pathToFileURL(
	path.join(import.meta.dirname, 'create-compile-hooks.ts'),
).href;

let testTmpRoot: string;
let tmpDir: string;
let outputDir: string;

/**
 * Writes a fixture site (layout + a shared component it imports + the named
 * pages) under `root`, creating the directory tree.
 * @param root - Site root directory
 * @param pageNames - Page basenames to create (each gets the shared layout)
 */
async function writeSite(root: string, pageNames: readonly string[] = ['a', 'b', 'c']) {
	const input = path.join(root, 'input');
	const layouts = path.join(root, 'layouts');
	const shared = path.join(root, 'shared');
	const data = path.join(root, 'data');
	await fs.mkdir(input, { recursive: true });
	await fs.mkdir(layouts, { recursive: true });
	await fs.mkdir(shared, { recursive: true });
	// A data dir makes the page compiler resolve global data, which populates
	// the page list / page asset files that feed the environment digest — so
	// adding or removing a page invalidates the others.
	await fs.mkdir(data, { recursive: true });

	await fs.writeFile(
		path.join(shared, 'Header.tsx'),
		'export function Header({ title }) { return <header><h1>{title}</h1></header>; }\n',
	);
	await fs.writeFile(
		path.join(layouts, 'default.tsx'),
		[
			"import { Header } from '../shared/Header.tsx';",
			'export default function Layout({ content, title }) {',
			'  return (',
			'    <html>',
			'      <head><title>{title}</title></head>',
			'      <body>',
			'        <Header title={title} />',
			'        <main dangerouslySetInnerHTML={{ __html: content }} />',
			'      </body>',
			'    </html>',
			'  );',
			'}',
			'',
		].join('\n'),
	);
	for (const name of pageNames) {
		await fs.writeFile(
			path.join(input, `page-${name}.tsx`),
			[
				'---',
				'layout: default.tsx',
				`title: Page ${name.toUpperCase()}`,
				'---',
				`export default function Page() { return <p>Hello ${name.toUpperCase()}</p>; }`,
				'',
			].join('\n'),
		);
	}
}

/**
 * Runs build() against the site rooted at `root`, in a real child process.
 * @param root - Site root directory
 * @param options - Build options
 * @param options.incremental - Enable incremental builds
 * @param options.jsxOptions - Forwarded to `createCompileHooks()`, to
 *   exercise cacheDigest reacting to JsxCompilerOptions changes
 */
async function buildSite(
	root: string,
	options?: { incremental?: boolean; jsxOptions?: Record<string, unknown> },
) {
	await runNodeScript(`
		const { createPageCompiler } = await import('@kamado-io/page-compiler');
		const { build } = await import('kamado/build');
		const { createCompileHooks } = await import('${createCompileHooksModuleUrl}');

		await build({
			pkg: { name: 'pipeline-fixture', version: '0.0.0' },
			rootDir: ${JSON.stringify(root)},
			dir: { input: ${JSON.stringify(path.join(root, 'input'))}, output: ${JSON.stringify(path.join(root, 'output'))} },
			incremental: ${JSON.stringify(Boolean(options?.incremental))},
			compilers: (def) => [
				def(createPageCompiler(), {
					files: '**/*.tsx',
					compileHooks: createCompileHooks(${JSON.stringify(options?.jsxOptions ?? {})}),
					layouts: { dir: ${JSON.stringify(path.join(root, 'layouts'))} },
					globalData: { dir: ${JSON.stringify(path.join(root, 'data'))} },
					transforms: [],
				}),
			],
		});
	`);
}

beforeAll(async () => {
	testTmpRoot = path.join(import.meta.dirname, '..', '.kamado', 'test-tmp');
	await fs.mkdir(testTmpRoot, { recursive: true });
	tmpDir = await fs.realpath(await fs.mkdtemp(path.join(testTmpRoot, 'build-pipeline-')));
	outputDir = path.join(tmpDir, 'output');
	await writeSite(tmpDir);
});

afterAll(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

/**
 * Runs build() against the shared (non-incremental describe) fixture site
 * @param options - Build options
 * @param options.incremental - Enable incremental builds
 */
async function buildFixture(options?: { incremental?: boolean }) {
	await buildSite(tmpDir, options);
}

describe('build pipeline (kamado core → page-compiler → jsx-compiler)', () => {
	test('builds jsx pages with a shared layout and shared component into the expected HTML', async () => {
		await buildFixture();

		const html = await fs.readFile(path.join(outputDir, 'page-a.html'), 'utf8');
		expect(html).toBe(
			'<html><head><title>Page A</title></head><body><header><h1>Page A</h1></header><main><p>Hello A</p></main></body></html>',
		);

		const outputs = await fs.readdir(outputDir);
		expect(outputs.toSorted()).toStrictEqual([
			'page-a.html',
			'page-b.html',
			'page-c.html',
		]);
	}, 30_000);

	test('reflects edits to a shared component on the next build in the same process', async () => {
		const headerPath = path.join(tmpDir, 'shared', 'Header.tsx');
		const original = await fs.readFile(headerPath, 'utf8');
		try {
			await fs.writeFile(
				headerPath,
				'export function Header({ title }) { return <header><h1>{title}</h1><p>Edited component</p></header>; }\n',
			);

			await buildFixture();

			const html = await fs.readFile(path.join(outputDir, 'page-b.html'), 'utf8');
			expect(html).toContain('<p>Edited component</p>');
		} finally {
			await fs.writeFile(headerPath, original);
		}
	}, 30_000);
});

describe('incremental build pipeline', () => {
	// Each test gets its own isolated site (fresh fixtures AND a fresh
	// .kamado/cache manifest), so editing fixtures or seeding the manifest in
	// one test cannot leak into another. The shared beforeAll fixture is left
	// untouched.
	let siteDir: string;
	let siteOutput: string;

	beforeEach(async () => {
		siteDir = await fs.realpath(
			await fs.mkdtemp(path.join(testTmpRoot, 'build-pipeline-inc-')),
		);
		siteOutput = path.join(siteDir, 'output');
		await writeSite(siteDir);
	});

	afterEach(async () => {
		await fs.rm(siteDir, { recursive: true, force: true });
	});

	test('a fully unchanged incremental rebuild rewrites nothing', async () => {
		await buildSite(siteDir, { incremental: true });
		const before = await fs.stat(path.join(siteOutput, 'page-a.html'));

		await sleep(20);
		await buildSite(siteDir, { incremental: true });

		const after = await fs.stat(path.join(siteOutput, 'page-a.html'));
		expect(after.mtimeMs).toBe(before.mtimeMs);
	}, 30_000);

	test('editing one page rebuilds that page and leaves the others untouched', async () => {
		await buildSite(siteDir, { incremental: true });
		const untouchedBefore = await fs.stat(path.join(siteOutput, 'page-a.html'));

		await sleep(20);
		await fs.writeFile(
			path.join(siteDir, 'input', 'page-b.tsx'),
			[
				'---',
				'layout: default.tsx',
				'title: Page B',
				'---',
				'export default function Page() { return <p>Hello B edited</p>; }',
				'',
			].join('\n'),
		);
		await buildSite(siteDir, { incremental: true });

		const edited = await fs.readFile(path.join(siteOutput, 'page-b.html'), 'utf8');
		expect(edited).toContain('<p>Hello B edited</p>');
		const untouchedAfter = await fs.stat(path.join(siteOutput, 'page-a.html'));
		expect(untouchedAfter.mtimeMs).toBe(untouchedBefore.mtimeMs);
	}, 30_000);

	test('editing a component imported by the layout rebuilds every page', async () => {
		// Proves the esbuild-bundled import is part of each page's verifying
		// trace — esbuild resolves it itself, outside kamado's file APIs.
		await buildSite(siteDir, { incremental: true });

		await fs.writeFile(
			path.join(siteDir, 'shared', 'Header.tsx'),
			'export function Header({ title }) { return <header><h1>{title}</h1><p>Component v2</p></header>; }\n',
		);
		await buildSite(siteDir, { incremental: true });

		for (const name of ['a', 'b', 'c']) {
			const html = await fs.readFile(path.join(siteOutput, `page-${name}.html`), 'utf8');
			expect(html).toContain('<p>Component v2</p>');
		}
	}, 30_000);

	test('editing the layout rebuilds every page', async () => {
		await buildSite(siteDir, { incremental: true });

		const layoutPath = path.join(siteDir, 'layouts', 'default.tsx');
		const layout = await fs.readFile(layoutPath, 'utf8');
		await fs.writeFile(
			layoutPath,
			layout.replace(
				'<main dangerouslySetInnerHTML',
				'<main className="v2" dangerouslySetInnerHTML',
			),
		);
		await buildSite(siteDir, { incremental: true });

		for (const name of ['a', 'b', 'c']) {
			const html = await fs.readFile(path.join(siteOutput, `page-${name}.html`), 'utf8');
			expect(html).toContain('<main class="v2">');
		}
	}, 30_000);

	test('adding a new page rebuilds existing pages (page list is part of the env digest)', async () => {
		// The page-compiler digest includes the page list and page asset files,
		// so adding a page invalidates every page even though their own sources
		// and dependencies are unchanged. Guards the pageAssetFiles/pageList
		// inclusion in the cacheDigest.
		await buildSite(siteDir, { incremental: true });
		const untouchedBefore = await fs.stat(path.join(siteOutput, 'page-a.html'));

		await sleep(20);
		await fs.writeFile(
			path.join(siteDir, 'input', 'page-d.tsx'),
			[
				'---',
				'layout: default.tsx',
				'title: Page D',
				'---',
				'export default function Page() { return <p>Hello D</p>; }',
				'',
			].join('\n'),
		);
		await buildSite(siteDir, { incremental: true });

		expect(await fs.readFile(path.join(siteOutput, 'page-d.html'), 'utf8')).toContain(
			'<p>Hello D</p>',
		);
		const untouchedAfter = await fs.stat(path.join(siteOutput, 'page-a.html'));
		expect(untouchedAfter.mtimeMs).toBeGreaterThan(untouchedBefore.mtimeMs);
	}, 30_000);

	test('changing JsxCompilerOptions (e.g. `define`) rebuilds every page even though no source file changed', async () => {
		// Guards createCompileHooks()'s cacheDigest: without it, a
		// jsx-compiler-level option change (or an esbuild/react/react-dom
		// upgrade) is invisible to page-compiler's own digest and an
		// incremental build would wrongly serve stale HTML.
		await buildSite(siteDir, { incremental: true });
		const before = await Promise.all(
			['a', 'b', 'c'].map((name) => fs.stat(path.join(siteOutput, `page-${name}.html`))),
		);

		await sleep(20);
		await buildSite(siteDir, {
			incremental: true,
			jsxOptions: { define: { KAMADO_TEST_FLAG: '"on"' } },
		});

		const after = await Promise.all(
			['a', 'b', 'c'].map((name) => fs.stat(path.join(siteOutput, `page-${name}.html`))),
		);
		for (const [i, element] of before.entries()) {
			expect(after[i]?.mtimeMs).toBeGreaterThan(element?.mtimeMs ?? 0);
		}
	}, 30_000);
});
