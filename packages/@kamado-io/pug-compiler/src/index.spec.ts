import { describe, test, expect } from 'vitest';

import { compilePug, createCompileHooks } from './index.js';

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
