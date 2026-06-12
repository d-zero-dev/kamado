import type { Context, TransformContext } from 'kamado/config';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { collectDependencies } from 'kamado/files';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { manipulateDOM } from './manipulate-dom.js';

/**
 * Creates a mock transform info object for testing
 * @param overrides - Optional overrides for specific fields
 * @returns Mock transform info
 */
function createMockTransformInfo(
	overrides?: Partial<TransformContext>,
): TransformContext {
	const defaultContext: TransformContext = {
		path: 'page.html',
		filePath: 'page.html',
		inputPath: '/test/input/page.html',
		outputPath: '/test/output/page.html',
		outputDir: '/test/output',
		isServe: false,
		context: {
			mode: 'build',
			dir: {
				root: '/test',
				input: '/test/input',
				output: '/test/output',
				public: '/test/public',
			},
			pkg: {
				production: {
					baseURL: 'https://example.com',
				},
			},
			compilers: [],
			devServer: {
				host: 'localhost',
				port: 3000,
			},
		} as Context,
		compile: () => Promise.resolve('<div>mock</div>'),
	};

	const merged = {
		...defaultContext,
		...overrides,
	};

	// Auto-set isServe based on context.mode if not explicitly overridden
	if (overrides?.context && !('isServe' in (overrides || {}))) {
		merged.isServe = merged.context.mode === 'serve';
	}

	return merged;
}

describe('manipulateDOM', () => {
	test('should have correct name', () => {
		const transform = manipulateDOM();
		expect(transform.name).toBe('manipulateDOM');
	});

	test('should return content unchanged when no hook and imageSizes is false', async () => {
		const transform = manipulateDOM({ imageSizes: false });
		const info = createMockTransformInfo();
		const content = '<p>test</p>';

		const result = await transform.transform(content, info);

		expect(result).toBe(content);
	});

	test('imageSizes reports referenced image files as dependencies even when fs.stat fails', async () => {
		// Guards two contracts at once:
		//  - incremental-build fix: imageSizes reads image files outside kamado's
		//    file APIs, so it must report each one via trackDependency or
		//    replacing an image leaves pages stale.
		//  - fs.stat failure path (.catch(() => null)): a missing file (ENOENT)
		//    or a permission-denied file (EACCES) is still tracked, but no
		//    width/height is emitted. Both error kinds hit the same null branch,
		//    so the missing-file case stands in for permission-denied as well.
		const transform = manipulateDOM();
		const info = createMockTransformInfo();

		const { dependencies, result } = await collectDependencies(() =>
			transform.transform('<html><body><img src="img/hero.png"></body></html>', info),
		);

		const expected = path.join(path.resolve(info.outputDir), 'img', 'hero.png');
		expect([...dependencies]).toContain(expected);

		// width/height must NOT be emitted when stat failed — parse the result
		// back through the DOM so attribute-order changes can't mask the bug.
		const serialized =
			typeof result === 'string' ? result : new TextDecoder().decode(result);
		const { document } = parseHTML(serialized);
		const img = document.querySelector('img');
		expect(img?.getAttribute('width')).toBeNull();
		expect(img?.getAttribute('height')).toBeNull();
	});

	test('should apply custom manipulateDOM hook', async () => {
		const customHook = vi.fn((elements, window) => {
			const body = window.document.querySelector('body');
			if (body) {
				const div = window.document.createElement('div');
				div.textContent = 'injected';
				body.append(div);
			}
		});

		const transform = manipulateDOM({ hook: customHook, imageSizes: false });
		const info = createMockTransformInfo();

		const result = await transform.transform('<html><body>test</body></html>', info);

		expect(customHook).toHaveBeenCalled();
		expect(result).toContain('injected');
	});

	test('hook ctx.getHref resolves <a href> against pkg.production.baseURL in build mode', async () => {
		const seen: { href?: string | null; baseURL?: string } = {};
		const transform = manipulateDOM({
			hook: (_elements, window, ctx) => {
				const a = window.document.querySelector('a');
				seen.href = a ? ctx.getHref(a) : null;
				seen.baseURL = ctx.baseURL;
			},
			imageSizes: false,
		});
		// default createMockTransformInfo() has isServe:false +
		// pkg.production.baseURL = 'https://example.com'
		const info = createMockTransformInfo();

		await transform.transform(
			'<html><body><a href="/path/to/page">x</a></body></html>',
			info,
		);

		expect(seen.baseURL).toBe('https://example.com');
		expect(seen.href).toBe('https://example.com/path/to/page');
	});

	test('hook ctx.getHref uses devServer URL in serve mode', async () => {
		const seen: { href?: string | null; baseURL?: string } = {};
		const transform = manipulateDOM({
			hook: (_elements, window, ctx) => {
				const a = window.document.querySelector('a');
				seen.href = a ? ctx.getHref(a) : null;
				seen.baseURL = ctx.baseURL;
			},
			imageSizes: false,
		});
		const info = createMockTransformInfo({
			isServe: true,
			context: {
				mode: 'serve',
				dir: {
					root: '/test',
					input: '/test/input',
					output: '/test/output',
					public: '/test/public',
				},
				devServer: { host: 'localhost', port: 4242 },
				pkg: {},
			} as Context,
		});

		await transform.transform('<html><body><a href="/foo">x</a></body></html>', info);

		expect(seen.baseURL).toBe('http://localhost:4242');
		expect(seen.href).toBe('http://localhost:4242/foo');
	});

	test('hook ctx.getHref returns null when no base is configured and href is relative', async () => {
		const seen: { href?: string | null; baseURL?: string } = {};
		const transform = manipulateDOM({
			hook: (_elements, window, ctx) => {
				const a = window.document.querySelector('a');
				seen.href = a ? ctx.getHref(a) : null;
				seen.baseURL = ctx.baseURL;
			},
			imageSizes: false,
		});
		const info = createMockTransformInfo({
			context: {
				mode: 'build',
				dir: {
					root: '/test',
					input: '/test/input',
					output: '/test/output',
					public: '/test/public',
				},
				devServer: { host: 'localhost', port: 3000 },
				// no pkg.production.baseURL and no pkg.production.host
				pkg: {},
			} as Context,
		});

		await transform.transform('<html><body><a href="/foo">x</a></body></html>', info);

		expect(seen.baseURL).toBeUndefined();
		expect(seen.href).toBeNull();
	});

	test('hook ctx.getHref leaves absolute href intact (ignores base)', async () => {
		const seen: { href?: string | null } = {};
		const transform = manipulateDOM({
			hook: (_elements, window, ctx) => {
				const a = window.document.querySelector('a');
				seen.href = a ? ctx.getHref(a) : null;
			},
			imageSizes: false,
		});
		const info = createMockTransformInfo();

		await transform.transform(
			'<html><body><a href="https://elsewhere.test/abs">x</a></body></html>',
			info,
		);

		expect(seen.href).toBe('https://elsewhere.test/abs');
	});

	test('should receive correct TransformContext in hook', async () => {
		let receivedContext: TransformContext | undefined;

		const transform = manipulateDOM({
			hook: (elements, window, context) => {
				receivedContext = context;
			},
			imageSizes: false,
		});

		const info = createMockTransformInfo({
			context: {
				mode: 'serve',
				dir: {
					root: '/test/root',
					output: '/test/output',
					input: '/test/input',
					public: '/test/public',
				},
				devServer: {
					host: 'localhost',
					port: 3000,
				},
				pkg: {},
			} as Context,
			inputPath: '/test/input/page.html',
			outputPath: '/test/output/page.html',
		});

		await transform.transform('<html><body>test</body></html>', info);

		expect(receivedContext).toBeDefined();
		expect(receivedContext?.path).toBe('page.html');
		expect(receivedContext?.isServe).toBe(true);
	});
});

/**
 * Captures `ctx.baseURL` as resolved by `manipulateDOM` for the given
 * TransformContext override. Useful for pinning the resolveBaseURL ladder
 * (empty-string, invalid URL, https fallback, missing devServer) without
 * threading boilerplate through every test.
 * @param ctxOverride
 */
async function getBaseURL(
	ctxOverride: Partial<TransformContext>,
): Promise<string | undefined> {
	let seen: string | undefined;
	const transform = manipulateDOM({
		hook: (_elements, _window, ctx) => {
			seen = ctx.baseURL;
		},
		imageSizes: false,
	});
	const info = createMockTransformInfo(ctxOverride);
	await transform.transform('<html><body>x</body></html>', info);
	return seen;
}

describe('manipulateDOM > ctx.baseURL resolution', () => {
	const buildCtx = (production: Record<string, unknown> | undefined) =>
		({
			context: {
				mode: 'build',
				dir: {
					root: '/test',
					input: '/test/input',
					output: '/test/output',
					public: '/test/public',
				},
				devServer: { host: 'localhost', port: 3000 },
				pkg: production === undefined ? {} : { production },
			} as Context,
		}) satisfies Partial<TransformContext>;

	test('empty baseURL is treated as missing', async () => {
		expect(await getBaseURL(buildCtx({ baseURL: '' }))).toBeUndefined();
	});

	test('whitespace-only baseURL is treated as missing', async () => {
		expect(await getBaseURL(buildCtx({ baseURL: '   ' }))).toBeUndefined();
	});

	test('baseURL without a scheme is rejected (returns undefined)', async () => {
		// `new URL('example.com')` throws — the parser refuses scheme-less inputs.
		expect(await getBaseURL(buildCtx({ baseURL: 'example.com' }))).toBeUndefined();
	});

	test('baseURL with surrounding whitespace is trimmed and accepted', async () => {
		expect(await getBaseURL(buildCtx({ baseURL: '  https://example.com  ' }))).toBe(
			'https://example.com',
		);
	});

	test('host-only fallback resolves to https:// (HTTPS-by-default)', async () => {
		// Documents the http→https default introduced when ctx.getHref started
		// emitting user-visible URLs; an http:// fallback would be a mixed-
		// content / SEO regression.
		expect(await getBaseURL(buildCtx({ host: 'example.com' }))).toBe(
			'https://example.com',
		);
	});

	test('empty host is treated as missing (no https:// emitted)', async () => {
		expect(await getBaseURL(buildCtx({ host: '' }))).toBeUndefined();
	});

	test('serve mode with missing devServer returns undefined (no TypeError)', async () => {
		// Pre-fix, resolveBaseURL dereferenced ctx.context.devServer.host
		// unconditionally and threw on partial contexts. This test pins the
		// optional-chained fallback.
		const ctx = {
			isServe: true,
			context: {
				mode: 'serve',
				dir: {
					root: '/test',
					input: '/test/input',
					output: '/test/output',
					public: '/test/public',
				},
				pkg: {},
			} as Context,
		} satisfies Partial<TransformContext>;
		expect(await getBaseURL(ctx)).toBeUndefined();
	});

	test('serve mode with devServer missing port returns undefined', async () => {
		const ctx = {
			isServe: true,
			context: {
				mode: 'serve',
				dir: {
					root: '/test',
					input: '/test/input',
					output: '/test/output',
					public: '/test/public',
				},
				devServer: { host: 'localhost' } as { host: string; port: number },
				pkg: {},
			} as Context,
		} satisfies Partial<TransformContext>;
		expect(await getBaseURL(ctx)).toBeUndefined();
	});
});

describe('manipulateDOM > imageSizes', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kamado-imagesizes-'));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	/**
	 *
	 * @param filename
	 * @param width
	 * @param height
	 */
	async function writeSvg(filename: string, width: number, height: number) {
		await fs.writeFile(
			path.join(tmpDir, filename),
			`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"></svg>`,
		);
	}

	test('adds width/height to <img> with a local src', async () => {
		await writeSvg('hero-img.svg', 160, 90);
		const transform = manipulateDOM();
		const info = createMockTransformInfo({ outputDir: tmpDir });

		const result = await transform.transform(
			'<html><body><img src="hero-img.svg"></body></html>',
			info,
		);

		const { document } = parseHTML(typeof result === 'string' ? result : '');
		const img = document.querySelector('img');
		expect(img?.getAttribute('width')).toBe('160');
		expect(img?.getAttribute('height')).toBe('90');
	});

	test('adds width/height to <picture> > <source>', async () => {
		await writeSvg('hero-source.svg', 320, 180);
		const transform = manipulateDOM();
		const info = createMockTransformInfo({ outputDir: tmpDir });

		const result = await transform.transform(
			'<html><body><picture><source src="hero-source.svg"><img src="hero-source.svg"></picture></body></html>',
			info,
		);

		const { document } = parseHTML(typeof result === 'string' ? result : '');
		const source = document.querySelector('source');
		const img = document.querySelector('img');
		expect(source?.getAttribute('width')).toBe('320');
		expect(source?.getAttribute('height')).toBe('180');
		expect(img?.getAttribute('width')).toBe('320');
		expect(img?.getAttribute('height')).toBe('180');
	});

	test('skips elements not matching the selector option', async () => {
		await writeSvg('hero-selector.svg', 100, 50);
		const transform = manipulateDOM({ imageSizes: { selector: 'img.target' } });
		const info = createMockTransformInfo({ outputDir: tmpDir });

		const result = await transform.transform(
			'<html><body><img class="other" src="hero-selector.svg"><img class="target" src="hero-selector.svg"></body></html>',
			info,
		);

		// Parse the result back through linkedom and assert via DOM rather than
		// regex on the serialized string — this guards against quoting and
		// attribute-order shifts that could otherwise let assertions pass vacuously.
		const { document } = parseHTML(result);
		const target = document.querySelector('img.target');
		const other = document.querySelector('img.other');
		expect(target?.getAttribute('width')).toBe('100');
		expect(target?.getAttribute('height')).toBe('50');
		expect(other?.getAttribute('width')).toBeNull();
		expect(other?.getAttribute('height')).toBeNull();
	});

	test('skips http(s)/protocol-relative/data URLs and unsupported extensions', async () => {
		// No local file is created. If the URL/extension guards work, the loop
		// short-circuits BEFORE trackDependency for every src. If a guard
		// regresses, the broken src reaches trackDependency and shows up in
		// the captured dependency set — distinguishing a real guard skip from
		// a downstream fs.stat null.
		const transform = manipulateDOM();
		const info = createMockTransformInfo({ outputDir: tmpDir });

		// Each src is crafted so that REMOVING the corresponding URL guard would
		// let it reach the extension check, satisfy it, and pollute the dependency
		// set — making this test a genuine regression alarm rather than a vacuous
		// pass dependent on fs.stat returning null.
		const html =
			'<html><body>' +
			// https:/// ends with .png — only the http(s) guard keeps it out
			'<img src="https://example.com/x.png">' +
			// // (protocol-relative) ends with .png — only the // guard keeps it out
			'<img src="//cdn.example.com/x.png">' +
			// data: URL whose payload terminates in .svg — only the data: guard
			// keeps it from polluting the dependency set
			'<img src="data:image/svg+xml;utf8,inline.svg">' +
			// unsupported extension — only the ext check keeps it out
			'<img src="local.txt">' +
			'</body></html>';

		const { dependencies, result } = await collectDependencies(() =>
			transform.transform(html, info),
		);

		expect([...dependencies]).toEqual([]);
		// Belt-and-braces: also assert no width/height was emitted via a DOM
		// parse so the assertions can't pass vacuously on missing tags.
		const serialized =
			typeof result === 'string' ? result : new TextDecoder().decode(result);
		const { document } = parseHTML(serialized);
		for (const img of document.querySelectorAll('img')) {
			expect(img.getAttribute('width')).toBeNull();
			expect(img.getAttribute('height')).toBeNull();
		}
	});
});
