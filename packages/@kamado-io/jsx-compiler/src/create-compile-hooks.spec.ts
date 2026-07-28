import type { CompileData, PageCompilerOptions } from '@kamado-io/page-compiler';
import type { CompilableFile, MetaData } from 'kamado/files';

import fs from 'node:fs/promises';
import path from 'node:path';

import { describe, test, expect, beforeEach, afterEach } from 'vitest';

import { createCompileHooks } from './create-compile-hooks.js';
import { runCreateCompileHooksScript } from './test-support/run-create-compile-hooks-script.js';

/**
 * Minimal CompileData stand-in for tests that only need `page.inputPath`
 * (the extension-passthrough/validation tests never reach the nav/titleList/
 * breadcrumbs fields).
 * @param inputPath - Path assigned to `page.inputPath`
 */
function fakeCompileData(inputPath: string): CompileData<MetaData> {
	return {
		page: { inputPath } as unknown as CompilableFile,
		nav: () => null,
		titleList: () => {},
		breadcrumbs: [],
	};
}

describe('create-compile-hooks', () => {
	describe('extension passthrough and validation (no dynamic import involved)', () => {
		test('passes non-jsx/tsx content through unchanged for both main and layout', async () => {
			const hooks = createCompileHooks<MetaData>()({} as PageCompilerOptions<MetaData>);
			const data = fakeCompileData('/tmp/page.html');

			await expect(hooks.main?.compiler?.('<p>raw</p>', data, '.html')).resolves.toBe(
				'<p>raw</p>',
			);
			await expect(hooks.layout?.compiler?.('<p>raw</p>', data, '.html')).resolves.toBe(
				'<p>raw</p>',
			);
		});

		test('throws a clear error when compiling a layout without layouts.dir set', async () => {
			const hooks = createCompileHooks<MetaData>()({} as PageCompilerOptions<MetaData>);
			const data = fakeCompileData('/tmp/page.tsx');

			await expect(
				hooks.layout?.compiler?.(
					'export default function Layout() { return null; }',
					data,
					'.tsx',
				),
			).rejects.toThrow(/layouts\.dir.*must be set/);
		});
	});

	describe('rendering behavior (real process required)', () => {
		let mainDir: string;
		let layoutsDir: string;

		beforeEach(async () => {
			// See compile-jsx.spec.ts: resolving react/react-dom requires a
			// resolveDir inside the workspace tree.
			const testTmpRoot = path.join(import.meta.dirname, '..', '.kamado', 'test-tmp');
			await fs.mkdir(testTmpRoot, { recursive: true });
			mainDir = await fs.realpath(
				await fs.mkdtemp(path.join(testTmpRoot, 'hooks-main-')),
			);
			layoutsDir = await fs.realpath(
				await fs.mkdtemp(path.join(testTmpRoot, 'hooks-layouts-')),
			);
		});

		afterEach(async () => {
			await fs.rm(mainDir, { recursive: true, force: true });
			await fs.rm(layoutsDir, { recursive: true, force: true });
		});

		test('main and layout use independent compiler instances with independent caches', async () => {
			const result = await runCreateCompileHooksScript<{
				main1: string;
				main2: string;
				layout1: string;
			}>(`
				const hooksFactory = createCompileHooks();
				const hooks = hooksFactory({ layouts: { dir: ${JSON.stringify(layoutsDir)} } });
				const source = 'let count = 0;\\nexport default function C() { count += 1; return <p>{count}</p>; }';
				const mainData = { page: { inputPath: ${JSON.stringify(path.join(mainDir, 'Page.tsx'))} } };
				const main1 = await hooks.main.compiler(source, mainData, '.tsx');
				const main2 = await hooks.main.compiler(source, mainData, '.tsx');
				const layout1 = await hooks.layout.compiler(source, mainData, '.tsx');
				console.log(JSON.stringify({ main1, main2, layout1 }));
			`);
			// Same instance for repeated main calls: count keeps incrementing.
			expect(result.main1).toBe('<p>1</p>');
			expect(result.main2).toBe('<p>2</p>');
			// A different instance backs the layout compiler: count restarts.
			expect(result.layout1).toBe('<p>1</p>');
		});

		test('compiles .jsx (not just .tsx) main content', async () => {
			const result = await runCreateCompileHooksScript<{ html: string }>(`
				const hooksFactory = createCompileHooks();
				const hooks = hooksFactory({ layouts: { dir: ${JSON.stringify(layoutsDir)} } });
				const mainData = { page: { inputPath: ${JSON.stringify(path.join(mainDir, 'Page.jsx'))} } };
				const html = await hooks.main.compiler(
					'export default function Page() { return <p>from jsx</p>; }',
					mainData,
					'.jsx',
				);
				console.log(JSON.stringify({ html }));
			`);
			expect(result.html).toBe('<p>from jsx</p>');
		});

		test('resolves relative imports against the page file directory for main, and layouts.dir for layout', async () => {
			await fs.writeFile(
				path.join(mainDir, 'Helper.tsx'),
				'export const label = "main-helper";',
			);
			await fs.writeFile(
				path.join(layoutsDir, 'Helper.tsx'),
				'export const label = "layout-helper";',
			);

			const result = await runCreateCompileHooksScript<{
				mainHtml: string;
				layoutHtml: string;
			}>(`
				const hooksFactory = createCompileHooks();
				const hooks = hooksFactory({ layouts: { dir: ${JSON.stringify(layoutsDir)} } });
				const source = "import { label } from './Helper.tsx';\\nexport default function C() { return <p>{label}</p>; }";
				const mainData = { page: { inputPath: ${JSON.stringify(path.join(mainDir, 'Page.tsx'))} } };
				const mainHtml = await hooks.main.compiler(source, mainData, '.tsx');
				const layoutHtml = await hooks.layout.compiler(source, mainData, '.tsx');
				console.log(JSON.stringify({ mainHtml, layoutHtml }));
			`);
			expect(result.mainHtml).toBe('<p>main-helper</p>');
			expect(result.layoutHtml).toBe('<p>layout-helper</p>');
		});

		test('layout component always receives the main content under a fixed `content` prop, regardless of contentVariableName', async () => {
			const result = await runCreateCompileHooksScript<{ html: string }>(`
				const hooksFactory = createCompileHooks();
				const hooks = hooksFactory({
					layouts: { dir: ${JSON.stringify(layoutsDir)}, contentVariableName: 'body' },
				});
				const layoutSource = 'export default function Layout({ content }) { return <div dangerouslySetInnerHTML={{ __html: content }} />; }';
				const data = {
					page: { inputPath: ${JSON.stringify(path.join(mainDir, 'Page.tsx'))} },
					body: '<p>main html</p>',
				};
				const html = await hooks.layout.compiler(layoutSource, data, '.tsx');
				console.log(JSON.stringify({ html }));
			`);
			expect(result.html).toBe('<div><p>main html</p></div>');
		});

		test('exposes cacheDigest on both main and layout compilers (copied from the underlying compileJsx() instances)', async () => {
			const result = await runCreateCompileHooksScript<{
				hasMainDigest: boolean;
				hasLayoutDigest: boolean;
				mainDigest: string;
				layoutDigest: string;
			}>(`
				const hooksFactory = createCompileHooks({ define: { FOO: '"bar"' } });
				const hooks = hooksFactory({ layouts: { dir: ${JSON.stringify(layoutsDir)} } });
				const hasMainDigest = typeof hooks.main.compiler.cacheDigest === 'function';
				const hasLayoutDigest = typeof hooks.layout.compiler.cacheDigest === 'function';
				const mainDigest = await hooks.main.compiler.cacheDigest();
				const layoutDigest = await hooks.layout.compiler.cacheDigest();
				console.log(JSON.stringify({ hasMainDigest, hasLayoutDigest, mainDigest, layoutDigest }));
			`);
			expect(result.hasMainDigest).toBe(true);
			expect(result.hasLayoutDigest).toBe(true);
			expect(typeof result.mainDigest).toBe('string');
			expect(result.mainDigest.length).toBeGreaterThan(0);
			// main and layout use separate compileJsx() instances (see class
			// doc), but were built from the same jsxOptions, so their digests
			// should agree.
			expect(result.mainDigest).toBe(result.layoutDigest);
		});

		test('throws instead of silently clobbering a pre-existing `content` field when contentVariableName is customized', async () => {
			await expect(
				runCreateCompileHooksScript(`
					const hooksFactory = createCompileHooks();
					const hooks = hooksFactory({
						layouts: { dir: ${JSON.stringify(layoutsDir)}, contentVariableName: 'body' },
					});
					const layoutSource = 'export default function Layout({ content }) { return <div dangerouslySetInnerHTML={{ __html: content }} />; }';
					const data = {
						page: { inputPath: ${JSON.stringify(path.join(mainDir, 'Page.tsx'))} },
						body: '<p>main html</p>',
						content: 'unrelated meta description',
					};
					await hooks.layout.compiler(layoutSource, data, '.tsx');
				`),
			).rejects.toThrow(/already has a 'content' key/);
		});
	});
});
