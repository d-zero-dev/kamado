import pug from 'pug';
import { describe, test, expect, vi, afterEach } from 'vitest';

import { compilePug, createCompileHooks } from './pug-compiler.js';

describe('pug-compiler', () => {
	test('should create a compiler function', async () => {
		const compiler = compilePug({
			doctype: 'html',
			pretty: true,
		});

		const html = await compiler('p Hello, world!', {});
		expect(html).toBe('\n<p>Hello, world!</p>');
	});

	test('should compile with data', async () => {
		const compiler = compilePug({
			doctype: 'html',
			pretty: true,
		});

		const html = await compiler('p= title', { title: 'My Page' });
		expect(html).toBe('\n<p>My Page</p>');
	});

	test('should use pathAlias option', async () => {
		const compiler = compilePug({
			pathAlias: './src',
			doctype: 'html',
			pretty: true,
		});

		const html = await compiler('p Hello', {});
		expect(html).toBe('\n<p>Hello</p>');
	});

	test('should create compile hooks', () => {
		const hooksFactory = createCompileHooks({
			doctype: 'html',
			pretty: true,
		});

		const hooks = hooksFactory();
		expect(hooks.main).toBeDefined();
		expect(hooks.main?.compiler).toBeDefined();
		expect(hooks.layout).toBeDefined();
		expect(hooks.layout?.compiler).toBeDefined();
	});

	describe('template function cache', () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		test('compiles the same template only once when cache is enabled', async () => {
			const compileSpy = vi.spyOn(pug, 'compile');
			const compiler = compilePug({ doctype: 'html', pretty: true });

			const first = await compiler('p= title', { title: 'A' });
			const second = await compiler('p= title', { title: 'B' });

			expect(first).toBe('\n<p>A</p>');
			expect(second).toBe('\n<p>B</p>');
			expect(compileSpy).toHaveBeenCalledTimes(1);
		});

		test('recompiles every time when cache is disabled', async () => {
			const compileSpy = vi.spyOn(pug, 'compile');
			const compiler = compilePug({ doctype: 'html', pretty: true });

			await compiler('p= title', { title: 'A' }, false);
			await compiler('p= title', { title: 'B' }, false);

			expect(compileSpy).toHaveBeenCalledTimes(2);
		});

		test('compiles different templates separately', async () => {
			const compileSpy = vi.spyOn(pug, 'compile');
			const compiler = compilePug({ doctype: 'html', pretty: true });

			await compiler('p one', {});
			await compiler('p two', {});

			expect(compileSpy).toHaveBeenCalledTimes(2);
		});

		test('passes the cache flag through createCompileHooks to the pug compiler', async () => {
			const compileSpy = vi.spyOn(pug, 'compile');
			const hooks = createCompileHooks({ doctype: 'html', pretty: true })();
			const compiler = hooks.main?.compiler;
			expect(compiler).toBeDefined();

			// cache=false (serve mode): recompiles every time
			// @ts-ignore
			await compiler?.('p= t', { t: 1 }, '.pug', false);
			// @ts-ignore
			await compiler?.('p= t', { t: 2 }, '.pug', false);
			expect(compileSpy).toHaveBeenCalledTimes(2);

			// cache undefined (build mode): compiled once, then reused
			compileSpy.mockClear();
			// @ts-ignore
			await compiler?.('p= u', { u: 1 }, '.pug');
			// @ts-ignore
			await compiler?.('p= u', { u: 2 }, '.pug');
			expect(compileSpy).toHaveBeenCalledTimes(1);
		});

		test('uses a fresh template cache per hooks-factory resolution', async () => {
			const compileSpy = vi.spyOn(pug, 'compile');
			const hooksFactory = createCompileHooks({ doctype: 'html', pretty: true });

			const first = hooksFactory();
			// @ts-ignore
			await first.main?.compiler?.('p shared', {}, '.pug');

			// A new resolution (= a new build context) must not reuse the
			// previous build's compiled templates
			const second = hooksFactory();
			// @ts-ignore
			await second.main?.compiler?.('p shared', {}, '.pug');

			expect(compileSpy).toHaveBeenCalledTimes(2);
		});

		test('evicts the least recently used template beyond the cache limit, keeping hot templates', async () => {
			const compileSpy = vi.spyOn(pug, 'compile');
			const compiler = compilePug({ doctype: 'html', pretty: true });

			// A "hot" template (e.g. a shared layout)
			await compiler('p hot', {});
			expect(compileSpy).toHaveBeenCalledTimes(1);

			// Fill the cache up to its limit (256) with unique templates
			for (let i = 0; i < 255; i++) {
				await compiler(`p unique-${i}`, {});
			}
			expect(compileSpy).toHaveBeenCalledTimes(256);

			// Touch the hot template: served from cache + refreshed in LRU order
			await compiler('p hot', {});
			expect(compileSpy).toHaveBeenCalledTimes(256);

			// One more unique template evicts the LRU entry — which must be
			// 'p unique-0', not the freshly touched hot template
			await compiler('p unique-overflow', {});
			expect(compileSpy).toHaveBeenCalledTimes(257);

			// Hot template is still cached...
			await compiler('p hot', {});
			expect(compileSpy).toHaveBeenCalledTimes(257);

			// ...but the evicted one is recompiled
			await compiler('p unique-0', {});
			expect(compileSpy).toHaveBeenCalledTimes(258);
		});

		test('does not share cache between compiler instances', async () => {
			const compileSpy = vi.spyOn(pug, 'compile');
			const compilerA = compilePug({ doctype: 'html', pretty: true });
			const compilerB = compilePug({ doctype: 'html', pretty: true });

			await compilerA('p shared', {});
			await compilerB('p shared', {});

			expect(compileSpy).toHaveBeenCalledTimes(2);
		});
	});

	test('should use the same compiler for main and layout', async () => {
		const hooksFactory = createCompileHooks({
			doctype: 'html',
			pretty: true,
		});

		const hooks = hooksFactory();
		const mainCompiler = hooks.main?.compiler;
		const layoutCompiler = hooks.layout?.compiler;

		expect(mainCompiler).toBe(layoutCompiler);

		if (mainCompiler) {
			const html = await mainCompiler(
				'p Test',
				// @ts-ignore
				{},
				'.pug',
			);
			expect(html).toBe('\n<p>Test</p>');
		}
	});
});
