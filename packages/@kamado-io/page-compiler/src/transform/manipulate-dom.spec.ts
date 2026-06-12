import type { Context, TransformContext } from 'kamado/config';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { collectDependencies } from 'kamado/files';
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

	test('imageSizes reports referenced image files as dependencies (tracked even when missing)', async () => {
		// Guards the incremental-build fix: the default imageSizes transform
		// reads image files outside kamado's file APIs, so it must report each
		// one via trackDependency or replacing an image leaves pages stale.
		// A missing image is still tracked (so adding it later invalidates).
		const transform = manipulateDOM(); // imageSizes enabled by default
		const info = createMockTransformInfo();

		const { dependencies } = await collectDependencies(() =>
			transform.transform('<html><body><img src="img/hero.png"></body></html>', info),
		);

		const expected = path.join(path.resolve(info.outputDir), 'img', 'hero.png');
		expect([...dependencies]).toContain(expected);
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

		expect(result).toContain('width="160"');
		expect(result).toContain('height="90"');
	});

	test('adds width/height to <picture> > <source>', async () => {
		await writeSvg('hero-source.svg', 320, 180);
		const transform = manipulateDOM();
		const info = createMockTransformInfo({ outputDir: tmpDir });

		const result = await transform.transform(
			'<html><body><picture><source src="hero-source.svg"><img src="hero-source.svg"></picture></body></html>',
			info,
		);

		// Attribute order varies between DOM implementations — check both tag and attrs.
		const sourceTag = result.match(/<source[^>]*>/)?.[0] ?? '';
		expect(sourceTag).toContain('width="320"');
		expect(sourceTag).toContain('height="180"');
		const imgTag = result.match(/<img[^>]*>/)?.[0] ?? '';
		expect(imgTag).toContain('width="320"');
		expect(imgTag).toContain('height="180"');
	});

	test('skips elements not matching the selector option', async () => {
		await writeSvg('hero-selector.svg', 100, 50);
		const transform = manipulateDOM({ imageSizes: { selector: 'img.target' } });
		const info = createMockTransformInfo({ outputDir: tmpDir });

		const result = await transform.transform(
			'<html><body><img class="other" src="hero-selector.svg"><img class="target" src="hero-selector.svg"></body></html>',
			info,
		);

		const tags = [...result.matchAll(/<img[^>]*>/g)].map((m) => m[0]);
		const target = tags.find((t) => t.includes('class="target"')) ?? '';
		const other = tags.find((t) => t.includes('class="other"')) ?? '';
		expect(target).toContain('width="100"');
		expect(target).toContain('height="50"');
		expect(other).not.toMatch(/width=/);
		expect(other).not.toMatch(/height=/);
	});

	test('skips http(s)/protocol-relative/data URLs and unsupported extensions', async () => {
		// No file needs to exist — these src values must all be skipped before fs access.
		const transform = manipulateDOM();
		const info = createMockTransformInfo({ outputDir: tmpDir });

		const html =
			'<html><body>' +
			'<img src="https://example.com/x.png">' +
			'<img src="//cdn.example.com/x.png">' +
			'<img src="data://image/png">' +
			'<img src="local.txt">' +
			'</body></html>';

		const result = await transform.transform(html, info);

		expect(result).not.toMatch(/<img[^>]*width=/);
		expect(result).not.toMatch(/<img[^>]*height=/);
	});
});
