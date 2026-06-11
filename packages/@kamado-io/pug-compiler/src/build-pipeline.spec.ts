import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { createPageCompiler } from '@kamado-io/page-compiler';
import { build } from 'kamado/build';
import {
	describe,
	test,
	expect,
	beforeAll,
	afterAll,
	beforeEach,
	afterEach,
	vi,
} from 'vitest';

import { createCompileHooks } from './pug-compiler.js';

/**
 * Real-FS integration test: runs the full build() pipeline
 * (kamado core → page-compiler → pug-compiler) with a shared layout that
 * includes a partial, and asserts the written HTML output.
 */

let tmpDir: string;
let outputDir: string;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;

/**
 * Writes a fixture site (layout + included partial + the named pages) under
 * `root`, creating the directory tree. Reused for the shared non-incremental
 * fixture and for each isolated incremental test.
 * @param root - Site root directory
 * @param pageNames - Page basenames to create (each gets the shared layout)
 */
async function writeSite(root: string, pageNames: readonly string[] = ['a', 'b', 'c']) {
	const input = path.join(root, 'input');
	const layouts = path.join(root, 'layouts');
	const partials = path.join(root, 'partials');
	const data = path.join(root, 'data');
	await fs.mkdir(input, { recursive: true });
	await fs.mkdir(layouts, { recursive: true });
	await fs.mkdir(partials, { recursive: true });
	// A data dir makes the page compiler resolve global data, which populates
	// the page list / page asset files that feed the environment digest — so
	// adding or removing a page invalidates the others.
	await fs.mkdir(data, { recursive: true });

	await fs.writeFile(
		path.join(partials, 'header.pug'),
		['mixin header(t)', '\theader', '\t\th1= t', ''].join('\n'),
	);
	await fs.writeFile(
		path.join(layouts, 'default.pug'),
		[
			'include /partials/header.pug',
			'doctype html',
			'html',
			'\thead',
			'\t\ttitle= title',
			'\tbody',
			'\t\t+header(title)',
			'\t\tmain !{content}',
			'',
		].join('\n'),
	);
	for (const name of pageNames) {
		await fs.writeFile(
			path.join(input, `page-${name}.pug`),
			[
				'---',
				'layout: default.pug',
				`title: Page ${name.toUpperCase()}`,
				'---',
				`p Hello ${name.toUpperCase()}`,
				'',
			].join('\n'),
		);
	}
}

/**
 * Runs build() against the site rooted at `root`
 * @param root - Site root directory
 * @param options - Build options
 * @param options.incremental - Enable incremental builds
 */
async function buildSite(root: string, options?: { incremental?: boolean }) {
	await build({
		// @ts-expect-error -- pkg is accepted by mergeConfig to skip package.json lookup
		pkg: { name: 'pipeline-fixture', version: '0.0.0' },
		rootDir: root,
		dir: { input: path.join(root, 'input'), output: path.join(root, 'output') },
		incremental: options?.incremental,
		compilers: (def) => [
			def(createPageCompiler(), {
				files: '**/*.pug',
				compileHooks: createCompileHooks({ basedir: root }),
				layouts: { dir: path.join(root, 'layouts') },
				globalData: { dir: path.join(root, 'data') },
				transforms: [],
			}),
		],
	});
}

beforeAll(async () => {
	consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kamado-build-pipeline-'));
	outputDir = path.join(tmpDir, 'output');
	await writeSite(tmpDir);
});

afterAll(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
	consoleLogSpy.mockRestore();
	stdoutWriteSpy.mockRestore();
});

/**
 * Runs build() against the shared (non-incremental describe) fixture site
 * @param options - Build options
 * @param options.incremental - Enable incremental builds
 */
async function buildFixture(options?: { incremental?: boolean }) {
	await buildSite(tmpDir, options);
}

describe('build pipeline (kamado core → page-compiler → pug-compiler)', () => {
	test('builds pug pages with a shared layout and include into the expected HTML', async () => {
		await buildFixture();

		const html = await fs.readFile(path.join(outputDir, 'page-a.html'), 'utf8');
		expect(html).toBe(
			[
				'<!DOCTYPE html>',
				'<html>',
				'  <head>',
				'    <title>Page A</title>',
				'  </head>',
				'  <body>',
				'    <header>',
				'      <h1>Page A</h1>',
				'    </header>',
				'    <main>',
				'<p>Hello A</p></main>',
				'  </body>',
				'</html>',
			].join('\n'),
		);

		// All pages are written
		const outputs = await fs.readdir(outputDir);
		expect(outputs.toSorted()).toStrictEqual([
			'page-a.html',
			'page-b.html',
			'page-c.html',
		]);
	});

	test('reflects edits to an included partial on the next build in the same process', async () => {
		const partialPath = path.join(tmpDir, 'partials', 'header.pug');
		const original = await fs.readFile(partialPath, 'utf8');
		try {
			await fs.writeFile(
				partialPath,
				['mixin header(t)', '\theader', '\t\th1= t', '\t\tp Edited partial', ''].join(
					'\n',
				),
			);

			await buildFixture();

			const html = await fs.readFile(path.join(outputDir, 'page-b.html'), 'utf8');
			expect(html).toContain('<p>Edited partial</p>');
		} finally {
			await fs.writeFile(partialPath, original);
		}
	});
});

describe('incremental build pipeline', () => {
	// Each test gets its own isolated site (fresh fixtures AND a fresh
	// .kamado/cache manifest), so editing fixtures or seeding the manifest in
	// one test cannot leak into another. The shared beforeAll fixture is left
	// untouched.
	let siteDir: string;
	let siteOutput: string;

	beforeEach(async () => {
		siteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kamado-build-pipeline-inc-'));
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
	});

	test('editing one page rebuilds that page and leaves the others untouched', async () => {
		await buildSite(siteDir, { incremental: true });
		const untouchedBefore = await fs.stat(path.join(siteOutput, 'page-a.html'));

		await sleep(20);
		await fs.writeFile(
			path.join(siteDir, 'input', 'page-b.pug'),
			['---', 'layout: default.pug', 'title: Page B', '---', 'p Hello B edited', ''].join(
				'\n',
			),
		);
		await buildSite(siteDir, { incremental: true });

		const edited = await fs.readFile(path.join(siteOutput, 'page-b.html'), 'utf8');
		expect(edited).toContain('<p>Hello B edited</p>');
		const untouchedAfter = await fs.stat(path.join(siteOutput, 'page-a.html'));
		expect(untouchedAfter.mtimeMs).toBe(untouchedBefore.mtimeMs);
	});

	test('editing an included pug partial rebuilds every page', async () => {
		// Proves the pug include is part of each page's verifying trace —
		// pug resolves includes itself, outside kamado's file APIs
		await buildSite(siteDir, { incremental: true });

		await fs.writeFile(
			path.join(siteDir, 'partials', 'header.pug'),
			['mixin header(t)', '\theader', '\t\th1= t', '\t\tp Partial v2', ''].join('\n'),
		);
		await buildSite(siteDir, { incremental: true });

		for (const name of ['a', 'b', 'c']) {
			const html = await fs.readFile(path.join(siteOutput, `page-${name}.html`), 'utf8');
			expect(html).toContain('<p>Partial v2</p>');
		}
	});

	test('editing the layout rebuilds every page', async () => {
		await buildSite(siteDir, { incremental: true });

		const layoutPath = path.join(siteDir, 'layouts', 'default.pug');
		const layout = await fs.readFile(layoutPath, 'utf8');
		await fs.writeFile(
			layoutPath,
			layout.replace('main !{content}', 'main.v2 !{content}'),
		);
		await buildSite(siteDir, { incremental: true });

		for (const name of ['a', 'b', 'c']) {
			const html = await fs.readFile(path.join(siteOutput, `page-${name}.html`), 'utf8');
			expect(html).toContain('<main class="v2">');
		}
	});

	test('adding a new page rebuilds existing pages (page list is part of the env digest)', async () => {
		// The page-compiler digest includes the page list and page asset files,
		// so adding a page invalidates every page even though their own sources
		// and dependencies are unchanged. Guards the pageAssetFiles/pageList
		// inclusion in the cacheDigest.
		await buildSite(siteDir, { incremental: true });
		const untouchedBefore = await fs.stat(path.join(siteOutput, 'page-a.html'));

		await sleep(20);
		await fs.writeFile(
			path.join(siteDir, 'input', 'page-d.pug'),
			['---', 'layout: default.pug', 'title: Page D', '---', 'p Hello D', ''].join('\n'),
		);
		await buildSite(siteDir, { incremental: true });

		// The new page is built, and an existing untouched page is rebuilt
		// because the page list changed
		expect(await fs.readFile(path.join(siteOutput, 'page-d.html'), 'utf8')).toContain(
			'<p>Hello D</p>',
		);
		const untouchedAfter = await fs.stat(path.join(siteOutput, 'page-a.html'));
		expect(untouchedAfter.mtimeMs).toBeGreaterThan(untouchedBefore.mtimeMs);
	});
});
