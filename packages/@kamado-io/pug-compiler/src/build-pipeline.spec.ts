import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { createPageCompiler } from '@kamado-io/page-compiler';
import { build } from 'kamado/build';
import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';

import { createCompileHooks } from './pug-compiler.js';

/**
 * Real-FS integration test: runs the full build() pipeline
 * (kamado core → page-compiler → pug-compiler) with a shared layout that
 * includes a partial, and asserts the written HTML output.
 */

let tmpDir: string;
let inputDir: string;
let outputDir: string;
let layoutsDir: string;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
	consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kamado-build-pipeline-'));
	inputDir = path.join(tmpDir, 'input');
	outputDir = path.join(tmpDir, 'output');
	layoutsDir = path.join(tmpDir, 'layouts');
	const partialsDir = path.join(tmpDir, 'partials');
	await fs.mkdir(inputDir, { recursive: true });
	await fs.mkdir(layoutsDir, { recursive: true });
	await fs.mkdir(partialsDir, { recursive: true });

	await fs.writeFile(
		path.join(partialsDir, 'header.pug'),
		['mixin header(t)', '\theader', '\t\th1= t', ''].join('\n'),
	);
	await fs.writeFile(
		path.join(layoutsDir, 'default.pug'),
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
	for (const name of ['a', 'b', 'c']) {
		await fs.writeFile(
			path.join(inputDir, `page-${name}.pug`),
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
});

afterAll(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
	consoleLogSpy.mockRestore();
	stdoutWriteSpy.mockRestore();
});

/**
 * Runs build() against the fixture site
 * @param options
 * @param options.incremental
 */
async function buildFixture(options?: { incremental?: boolean }) {
	await build({
		// @ts-expect-error -- pkg is accepted by mergeConfig to skip package.json lookup
		pkg: { name: 'pipeline-fixture', version: '0.0.0' },
		rootDir: tmpDir,
		dir: { input: inputDir, output: outputDir },
		incremental: options?.incremental,
		compilers: (def) => [
			def(createPageCompiler(), {
				files: '**/*.pug',
				compileHooks: createCompileHooks({ basedir: tmpDir }),
				layouts: { dir: layoutsDir },
				transforms: [],
			}),
		],
	});
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
	test('a fully unchanged incremental rebuild rewrites nothing', async () => {
		await buildFixture({ incremental: true });
		const before = await fs.stat(path.join(outputDir, 'page-a.html'));

		await sleep(20);
		await buildFixture({ incremental: true });

		const after = await fs.stat(path.join(outputDir, 'page-a.html'));
		expect(after.mtimeMs).toBe(before.mtimeMs);
	});

	test('editing one page rebuilds that page and leaves the others untouched', async () => {
		await buildFixture({ incremental: true });
		const untouchedBefore = await fs.stat(path.join(outputDir, 'page-a.html'));

		await sleep(20);
		await fs.writeFile(
			path.join(inputDir, 'page-b.pug'),
			['---', 'layout: default.pug', 'title: Page B', '---', 'p Hello B edited', ''].join(
				'\n',
			),
		);
		await buildFixture({ incremental: true });

		const edited = await fs.readFile(path.join(outputDir, 'page-b.html'), 'utf8');
		expect(edited).toContain('<p>Hello B edited</p>');
		const untouchedAfter = await fs.stat(path.join(outputDir, 'page-a.html'));
		expect(untouchedAfter.mtimeMs).toBe(untouchedBefore.mtimeMs);
	});

	test('editing an included pug partial rebuilds every page', async () => {
		// Proves the pug include is part of each page's verifying trace —
		// pug resolves includes itself, outside kamado's file APIs
		await buildFixture({ incremental: true });

		await fs.writeFile(
			path.join(tmpDir, 'partials', 'header.pug'),
			['mixin header(t)', '\theader', '\t\th1= t', '\t\tp Partial v2', ''].join('\n'),
		);
		await buildFixture({ incremental: true });

		for (const name of ['a', 'c']) {
			const html = await fs.readFile(path.join(outputDir, `page-${name}.html`), 'utf8');
			expect(html).toContain('<p>Partial v2</p>');
		}
	});

	test('editing the layout rebuilds every page', async () => {
		await buildFixture({ incremental: true });

		const layoutPath = path.join(layoutsDir, 'default.pug');
		const layout = await fs.readFile(layoutPath, 'utf8');
		await fs.writeFile(
			layoutPath,
			layout.replace('main !{content}', 'main.v2 !{content}'),
		);
		await buildFixture({ incremental: true });

		const html = await fs.readFile(path.join(outputDir, 'page-c.html'), 'utf8');
		expect(html).toContain('<main class="v2">');
	});
});
