import fs from 'node:fs/promises';
import path from 'node:path';

import { describe, test, expect, beforeEach, afterEach } from 'vitest';

import { runCompileJsxScript } from './test-support/run-compile-jsx-script.js';

/**
 * A component whose module keeps a mutable `count` that increments on every
 * render call. Since ESM modules are singletons per URL, `count` only
 * persists across renders when the *same* module instance (i.e. a cache
 * hit) serves them — a fresh bundle+import always restarts at 0. This lets
 * cache-hit/miss behavior be observed as a plain return value instead of
 * spying on `bundleJsx` (which lives in a different process — see
 * run-compile-jsx-script.ts).
 * @param name - Function name for the generated component (must be a valid identifier)
 */
function countingSource(name: string): string {
	return `let count = 0;\nexport default function ${name}() { count += 1; return <p>{count}</p>; }`;
}

describe('compile-jsx', () => {
	let tmpDir: string;

	beforeEach(async () => {
		// Rendering a component actually imports it, which resolves the
		// bare `react`/`react-dom` specifiers by walking up from resolveDir
		// looking for node_modules. Unlike bundle-jsx (where react is only
		// ever external, never resolved), this test's tmpDir must therefore
		// live inside the workspace tree — os.tmpdir() has no node_modules
		// above it. `.kamado/` is already gitignored for build-cache use.
		const testTmpRoot = path.join(import.meta.dirname, '..', '.kamado', 'test-tmp');
		await fs.mkdir(testTmpRoot, { recursive: true });
		tmpDir = await fs.realpath(await fs.mkdtemp(path.join(testTmpRoot, 'compile-test-')));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test('renders a simple component to a static HTML string', async () => {
		const filePath = path.join(tmpDir, 'Page.tsx');
		const result = await runCompileJsxScript<{ html: string }>(`
			const compiler = compileJsx();
			const html = await compiler(
				'export default function Page({ title }) { return <h1 className="t">{title}</h1>; }',
				{ title: 'Hello' },
				${JSON.stringify(tmpDir)},
				${JSON.stringify(filePath)},
			);
			console.log(JSON.stringify({ html }));
		`);
		expect(result.html).toBe('<h1 class="t">Hello</h1>');
	});

	test('renders through a non-default jsxImportSource (react-dom/server-compatible runtime)', async () => {
		// A minimal fake JSX runtime, installed as a real node_modules package.
		// `resolveJsxRuntime`'s `import(jsxImportSource)` / `import(\`${jsxImportSource}/server\`)`
		// resolve relative to compile-jsx.ts's own location (not resolveDir —
		// unlike the bundled component's own imports, which esbuild resolves
		// against resolveDir), so the fake package must be reachable from
		// there: the workspace root's node_modules, which every package
		// resolves up to. Installed/removed for just this test to avoid
		// leaking into others or concurrent runs.
		const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..');
		const runtimeDir = path.join(
			repoRoot,
			'node_modules',
			'jsx-compiler-test-fake-runtime',
		);
		await fs.rm(runtimeDir, { recursive: true, force: true });
		await fs.mkdir(runtimeDir, { recursive: true });
		try {
			await fs.writeFile(
				path.join(runtimeDir, 'package.json'),
				JSON.stringify({
					name: 'jsx-compiler-test-fake-runtime',
					version: '0.0.0',
					exports: {
						'.': './index.js',
						'./jsx-runtime': './jsx-runtime.js',
						'./server': './server.js',
					},
				}),
			);
			await fs.writeFile(
				path.join(runtimeDir, 'index.js'),
				'export function createElement(type, props, ...children) { return { type, props: props || {}, children }; }\n',
			);
			await fs.writeFile(
				path.join(runtimeDir, 'jsx-runtime.js'),
				[
					"import { createElement } from './index.js';",
					'export function jsx(type, props) { const { children, ...rest } = props || {}; return createElement(type, rest, children); }',
					'export const jsxs = jsx;',
					'',
				].join('\n'),
			);
			await fs.writeFile(
				path.join(runtimeDir, 'server.js'),
				[
					'function renderElement(el) {',
					"  if (el == null || typeof el === 'boolean') return '';",
					"  if (typeof el === 'string' || typeof el === 'number') return String(el);",
					'  if (Array.isArray(el)) return el.map(renderElement).join("");',
					"  if (typeof el.type === 'function') {",
					'    return renderElement(el.type({ ...el.props, children: el.children }));',
					'  }',
					'  const attrs = Object.entries(el.props || {}).map(([k, v]) => ` ${k}="${v}"`).join(\'\');',
					'  const childrenHtml = (Array.isArray(el.children) ? el.children : [el.children]).map(renderElement).join("");',
					'  return `<${el.type}${attrs}>${childrenHtml}</${el.type}>`;',
					'}',
					'export function renderToStaticMarkup(el) { return renderElement(el); }',
					'',
				].join('\n'),
			);

			const filePath = path.join(tmpDir, 'Page.tsx');
			const result = await runCompileJsxScript<{ html: string }>(`
				const compiler = compileJsx({ jsxImportSource: 'jsx-compiler-test-fake-runtime' });
				const html = await compiler(
					'export default function Page({ title }) { return <h1 data-title={title}>{title}</h1>; }',
					{ title: 'Hello' },
					${JSON.stringify(tmpDir)},
					${JSON.stringify(filePath)},
				);
				console.log(JSON.stringify({ html }));
			`);
			// The fake runtime doesn't replicate react-dom's className->class
			// rewrite, so this asserts on an attribute it passes through as-is.
			expect(result.html).toBe('<h1 data-title="Hello">Hello</h1>');
		} finally {
			await fs.rm(runtimeDir, { recursive: true, force: true });
		}
	});

	test('allows standard React hooks (useMemo) in SSR', async () => {
		const filePath = path.join(tmpDir, 'Page.tsx');
		const result = await runCompileJsxScript<{ html: string }>(`
			const compiler = compileJsx();
			const html = await compiler(
				"import { useMemo } from 'react';\\nexport default function Page({ n }) { const doubled = useMemo(() => n * 2, [n]); return <p>{doubled}</p>; }",
				{ n: 3 },
				${JSON.stringify(tmpDir)},
				${JSON.stringify(filePath)},
			);
			console.log(JSON.stringify({ html }));
		`);
		expect(result.html).toBe('<p>6</p>');
	});

	describe('component cache', () => {
		test('reuses the same module instance for the same source when cache is enabled', async () => {
			const filePath = path.join(tmpDir, 'Page.tsx');
			const result = await runCompileJsxScript<{ first: string; second: string }>(`
				const compiler = compileJsx();
				const source = ${JSON.stringify(countingSource('Page'))};
				const first = await compiler(source, {}, ${JSON.stringify(tmpDir)}, ${JSON.stringify(filePath)});
				const second = await compiler(source, {}, ${JSON.stringify(tmpDir)}, ${JSON.stringify(filePath)});
				console.log(JSON.stringify({ first, second }));
			`);
			// count keeps incrementing => same module instance => bundled once
			expect(result.first).toBe('<p>1</p>');
			expect(result.second).toBe('<p>2</p>');
		});

		test('rebuilds a fresh module instance every time when cache is disabled', async () => {
			const filePath = path.join(tmpDir, 'Page.tsx');
			const result = await runCompileJsxScript<{ first: string; second: string }>(`
				const compiler = compileJsx();
				const source = ${JSON.stringify(countingSource('Page'))};
				const first = await compiler(source, {}, ${JSON.stringify(tmpDir)}, ${JSON.stringify(filePath)}, false);
				const second = await compiler(source, {}, ${JSON.stringify(tmpDir)}, ${JSON.stringify(filePath)}, false);
				console.log(JSON.stringify({ first, second }));
			`);
			// count restarts at 1 each time => fresh module instance => re-bundled
			expect(result.first).toBe('<p>1</p>');
			expect(result.second).toBe('<p>1</p>');
		});

		test('does not share cache between compiler instances', async () => {
			const filePath = path.join(tmpDir, 'Page.tsx');
			const result = await runCompileJsxScript<{ first: string; second: string }>(`
				const compilerA = compileJsx();
				const compilerB = compileJsx();
				const source = ${JSON.stringify(countingSource('Page'))};
				const first = await compilerA(source, {}, ${JSON.stringify(tmpDir)}, ${JSON.stringify(filePath)});
				const second = await compilerB(source, {}, ${JSON.stringify(tmpDir)}, ${JSON.stringify(filePath)});
				console.log(JSON.stringify({ first, second }));
			`);
			expect(result.first).toBe('<p>1</p>');
			expect(result.second).toBe('<p>1</p>');
		});

		test('caches the same source separately per resolveDir', async () => {
			const otherDir = path.join(tmpDir, 'other');
			await fs.mkdir(otherDir, { recursive: true });
			const filePath = path.join(tmpDir, 'Page.tsx');
			const otherFilePath = path.join(otherDir, 'Page.tsx');
			const result = await runCompileJsxScript<{
				first: string;
				second: string;
				third: string;
			}>(`
				const compiler = compileJsx();
				const source = ${JSON.stringify(countingSource('Page'))};
				const first = await compiler(source, {}, ${JSON.stringify(tmpDir)}, ${JSON.stringify(filePath)});
				const second = await compiler(source, {}, ${JSON.stringify(otherDir)}, ${JSON.stringify(otherFilePath)});
				const third = await compiler(source, {}, ${JSON.stringify(tmpDir)}, ${JSON.stringify(filePath)});
				console.log(JSON.stringify({ first, second, third }));
			`);
			// Different resolveDir => separate cache entry => count restarts.
			expect(result.first).toBe('<p>1</p>');
			expect(result.second).toBe('<p>1</p>');
			// Back to the original resolveDir's entry: count keeps incrementing.
			expect(result.third).toBe('<p>2</p>');
		});

		test('caches byte-identical sources separately per filePath (so //# sourceURL= never points at the wrong file)', async () => {
			const filePathA = path.join(tmpDir, 'PageA.tsx');
			const filePathB = path.join(tmpDir, 'PageB.tsx');
			const result = await runCompileJsxScript<{ first: string; second: string }>(`
				const compiler = compileJsx();
				const source = ${JSON.stringify(countingSource('Page'))};
				const first = await compiler(source, {}, ${JSON.stringify(tmpDir)}, ${JSON.stringify(filePathA)});
				const second = await compiler(source, {}, ${JSON.stringify(tmpDir)}, ${JSON.stringify(filePathB)});
				console.log(JSON.stringify({ first, second }));
			`);
			// Same resolveDir and source, but different filePath => separate
			// cache entry => count restarts instead of continuing from PageA's.
			expect(result.first).toBe('<p>1</p>');
			expect(result.second).toBe('<p>1</p>');
		});

		test('deduplicates concurrent compiles of the same not-yet-cached source', async () => {
			const filePath = path.join(tmpDir, 'Page.tsx');
			const result = await runCompileJsxScript<{ results: string[] }>(`
				const compiler = compileJsx();
				const source = ${JSON.stringify(countingSource('Page'))};
				const results = await Promise.all([
					compiler(source, {}, ${JSON.stringify(tmpDir)}, ${JSON.stringify(filePath)}),
					compiler(source, {}, ${JSON.stringify(tmpDir)}, ${JSON.stringify(filePath)}),
					compiler(source, {}, ${JSON.stringify(tmpDir)}, ${JSON.stringify(filePath)}),
				]);
				console.log(JSON.stringify({ results }));
			`);
			// If the three concurrent calls were deduplicated into a single
			// bundle+import, they share one module instance, so the three
			// increments never collide: {1, 2, 3} in some order.
			expect(new Set(result.results)).toEqual(
				new Set(['<p>1</p>', '<p>2</p>', '<p>3</p>']),
			);
		});

		test('evicts the least recently used component beyond the cache limit, keeping hot components', async () => {
			const filePath = path.join(tmpDir, 'Page.tsx');
			const result = await runCompileJsxScript<{
				hotAfterFill: string;
				hotAfterOverflow: string;
				u0AfterEviction: string;
			}>(`
					const compiler = compileJsx();
					const resolveDir = ${JSON.stringify(tmpDir)};
					const filePath = ${JSON.stringify(filePath)};
					const render = (source) => compiler(source, {}, resolveDir, filePath);

					const hotSource = ${JSON.stringify(countingSource('Hot'))};
					await render(hotSource); // count=1

					for (let i = 0; i < 255; i++) {
						await render(\`let count = 0;\\nexport default function U\${i}() { count += 1; return <p>{count}</p>; }\`);
					}

					// Touch the hot component: served from cache (count=2) +
					// refreshed in LRU order
					const hotAfterFill = await render(hotSource);

					// One more unique component evicts the LRU entry — 'U0',
					// not the freshly touched hot component
					await render('let count = 0;\\nexport default function Overflow() { count += 1; return <p>{count}</p>; }');

					// Hot is still cached: count keeps incrementing (3)
					const hotAfterOverflow = await render(hotSource);

					// U0 was evicted: recompiled => fresh module instance => count restarts at 1
					const u0AfterEviction = await render('let count = 0;\\nexport default function U0() { count += 1; return <p>{count}</p>; }');

					console.log(JSON.stringify({ hotAfterFill, hotAfterOverflow, u0AfterEviction }));
				`);
			expect(result.hotAfterFill).toBe('<p>2</p>');
			expect(result.hotAfterOverflow).toBe('<p>3</p>');
			expect(result.u0AfterEviction).toBe('<p>1</p>');
		}, 60_000);
	});

	test('throws a clear error when the file has no default export function', async () => {
		const filePath = path.join(tmpDir, 'Page.tsx');
		const result = await runCompileJsxScript<{ message: string }>(`
			const compiler = compileJsx();
			try {
				await compiler('export const notDefault = 1;', {}, ${JSON.stringify(tmpDir)}, ${JSON.stringify(filePath)});
				console.log(JSON.stringify({ message: null }));
			} catch (error) {
				console.log(JSON.stringify({ message: error.message }));
			}
		`);
		expect(result.message).toMatch(/must `export default` a function component/);
	});

	test('wraps a rendering error with the original as cause, sourceURL pointing at the origin file', async () => {
		const filePath = path.join(tmpDir, 'Page.tsx');
		const result = await runCompileJsxScript<{
			message: string;
			causeMessage: string;
			causeStackIncludesFile: boolean;
		}>(`
			const compiler = compileJsx();
			const filePath = ${JSON.stringify(filePath)};
			try {
				await compiler(
					'export default function Page() { throw new Error("boom"); }',
					{},
					${JSON.stringify(tmpDir)},
					filePath,
				);
				console.log(JSON.stringify({ message: null, causeMessage: null, causeStackIncludesFile: false }));
			} catch (error) {
				console.log(JSON.stringify({
					message: error.message,
					causeMessage: error.cause?.message ?? null,
					causeStackIncludesFile: error.cause?.stack?.includes(filePath) ?? false,
				}));
			}
		`);
		expect(result.message).toContain('Failed to render JSX/TSX component');
		expect(result.causeMessage).toBe('boom');
		expect(result.causeStackIncludesFile).toBe(true);
	});

	test('reports imported sibling files as dependencies via trackDependency, even on cache hits', async () => {
		const buttonPath = path.join(tmpDir, 'Button.tsx');
		await fs.writeFile(
			buttonPath,
			'export function Button() { return <button>Click</button>; }',
		);
		const filePath = path.join(tmpDir, 'Page.tsx');
		const source =
			"import { Button } from './Button.tsx';\nexport default function Page() { return <Button />; }";

		const result = await runCompileJsxScript<{
			firstDeps: string[];
			secondDeps: string[];
		}>(`
			const { collectDependencies } = await import('kamado/files');
			const compiler = compileJsx();
			const { dependencies: firstDeps } = await collectDependencies(() =>
				compiler(${JSON.stringify(source)}, {}, ${JSON.stringify(tmpDir)}, ${JSON.stringify(filePath)}),
			);
			const { dependencies: secondDeps } = await collectDependencies(() =>
				compiler(${JSON.stringify(source)}, {}, ${JSON.stringify(tmpDir)}, ${JSON.stringify(filePath)}),
			);
			console.log(JSON.stringify({ firstDeps: [...firstDeps], secondDeps: [...secondDeps] }));
		`);
		expect(result.firstDeps.some((dep) => dep.endsWith(`${path.sep}Button.tsx`))).toBe(
			true,
		);
		expect(result.secondDeps.some((dep) => dep.endsWith(`${path.sep}Button.tsx`))).toBe(
			true,
		);
	});

	describe('cacheDigest', () => {
		test('returns a stable string for the same options', async () => {
			const result = await runCompileJsxScript<{ first: string; second: string }>(`
				const compiler = compileJsx({ define: { FOO: '"bar"' } });
				const first = await compiler.cacheDigest();
				const second = await compiler.cacheDigest();
				console.log(JSON.stringify({ first, second }));
			`);
			expect(typeof result.first).toBe('string');
			expect(result.first.length).toBeGreaterThan(0);
			expect(result.first).toBe(result.second);
		});

		test('differs when JsxCompilerOptions differ', async () => {
			const result = await runCompileJsxScript<{ a: string; b: string }>(`
				const a = await compileJsx({ define: { FOO: '"bar"' } }).cacheDigest();
				const b = await compileJsx({ define: { FOO: '"baz"' } }).cacheDigest();
				console.log(JSON.stringify({ a, b }));
			`);
			expect(result.a).not.toBe(result.b);
		});

		test('differs when the resolved runtime version differs (jsxImportSource pinned to two different fake-runtime versions)', async () => {
			// createCacheDigest hashes its input, so a version string can't be
			// read back out of a digest directly — instead, this proves the
			// runtime's declared `version` actually reaches the digest by
			// installing the same fake runtime twice under different names,
			// differing only in package.json's `version` field.
			const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..');
			const writeRuntime = async (name: string, version: string) => {
				const dir = path.join(repoRoot, 'node_modules', name);
				await fs.rm(dir, { recursive: true, force: true });
				await fs.mkdir(dir, { recursive: true });
				await fs.writeFile(
					path.join(dir, 'package.json'),
					JSON.stringify({
						name,
						version,
						exports: {
							'.': './index.js',
							'./jsx-runtime': './jsx-runtime.js',
							'./server': './server.js',
						},
					}),
				);
				await fs.writeFile(
					path.join(dir, 'index.js'),
					[
						`export const version = ${JSON.stringify(version)};`,
						'export function createElement(type, props, ...children) { return { type, props: props || {}, children }; }',
						'',
					].join('\n'),
				);
				await fs.writeFile(
					path.join(dir, 'jsx-runtime.js'),
					[
						"import { createElement } from './index.js';",
						'export function jsx(type, props) { const { children, ...rest } = props || {}; return createElement(type, rest, children); }',
						'export const jsxs = jsx;',
						'',
					].join('\n'),
				);
				await fs.writeFile(
					path.join(dir, 'server.js'),
					[
						`export const version = ${JSON.stringify(version)};`,
						'export function renderToStaticMarkup() { return ""; }',
						'',
					].join('\n'),
				);
			};

			const nameA = 'jsx-compiler-test-digest-runtime-a';
			const nameB = 'jsx-compiler-test-digest-runtime-b';
			try {
				await writeRuntime(nameA, '1.0.0');
				await writeRuntime(nameB, '2.0.0');

				const result = await runCompileJsxScript<{ a: string; b: string }>(`
					const a = await compileJsx({ jsxImportSource: ${JSON.stringify(nameA)} }).cacheDigest();
					const b = await compileJsx({ jsxImportSource: ${JSON.stringify(nameB)} }).cacheDigest();
					console.log(JSON.stringify({ a, b }));
				`);
				expect(result.a).not.toBe(result.b);
			} finally {
				await fs.rm(path.join(repoRoot, 'node_modules', nameA), {
					recursive: true,
					force: true,
				});
				await fs.rm(path.join(repoRoot, 'node_modules', nameB), {
					recursive: true,
					force: true,
				});
			}
		});
	});
});
