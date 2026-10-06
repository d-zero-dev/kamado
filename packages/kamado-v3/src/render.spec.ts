import type { RenderContext } from './props.js';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createRenderer } from './render.js';

let dir = '';

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'kamado-render-'));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const CONTEXT: RenderContext = {
	site: {
		host: null,
		baseURL: null,
		siteName: null,
		siteNameEn: null,
		name: null,
		version: null,
	},
	data: {},
	pages: [
		{
			url: '/a/',
			inputPath: '/s/a.tsx',
			outputPath: '/o/a/index.html',
			fileSlug: 'a',
			filePathStem: '/a/index',
			extension: '.html',
			date: '2026-01-01T00:00:00.000Z',
			meta: {},
		},
		{
			url: '/b/',
			inputPath: '/s/b.tsx',
			outputPath: '/o/b/index.html',
			fileSlug: 'b',
			filePathStem: '/b/index',
			extension: '.html',
			date: '2026-01-01T00:00:00.000Z',
			meta: {},
		},
	],
};

/**
 * Writes a file of `dir` and returns its absolute path.
 * @param name - File name
 * @param text - Content
 */
async function write(name: string, text: string): Promise<string> {
	const file = path.join(dir, name);
	await writeFile(file, text);
	return file;
}

/** A runtime that renders a component to the text it returns. */
async function runtimeUrl(): Promise<string> {
	const file = await write(
		'runtime.mjs',
		'export const render = (component, props) => String(component(props));\n',
	);
	return pathToFileURL(file).href;
}

describe('createRenderer', () => {
	test('a page that is a function of a chunk is run and its default export rendered', async () => {
		const chunk = await write(
			'chunk.mjs',
			[
				'export const pages = [',
				'  async () => ({ default: (p) => `<p>first ${p.page.url}</p>` }),',
				'  async () => ({ default: (p) => `<p>second ${p.page.url}</p>` }),',
				'];',
			].join('\n'),
		);
		const render = await createRenderer(CONTEXT, await runtimeUrl());

		expect(
			await render({ page: 1, main: chunk, entry: 1, layout: null, content: null }),
		).toEqual([1, '<p>second /b/</p>']);
		expect(
			await render({ page: 0, main: chunk, entry: 0, layout: null, content: null }),
		).toEqual([0, '<p>first /a/</p>']);
	});

	test('a compiled module that is not in a chunk is still imported as a file', async () => {
		const file = await write(
			'page.mjs',
			'export default (p) => `<p>module ${p.page.url}</p>`;\n',
		);
		const render = await createRenderer(CONTEXT, await runtimeUrl());

		expect(await render({ page: 0, main: file, layout: null, content: null })).toEqual([
			0,
			'<p>module /a/</p>',
		]);
	});

	test('a layout wraps what the page rendered', async () => {
		const chunk = await write(
			'chunk.mjs',
			'export const pages = [async () => ({ default: () => "<b>x</b>" })];\n',
		);
		const layout = await write(
			'layout.mjs',
			'export default (p) => `<main>${p.content}</main>`;\n',
		);
		const render = await createRenderer(CONTEXT, await runtimeUrl());

		expect(
			await render({ page: 0, main: chunk, entry: 0, layout, content: null }),
		).toEqual([0, '<main><b>x</b></main>']);
	});

	test('a page that does not export a component, or is not in the chunk, fails with its path', async () => {
		const chunk = await write(
			'chunk.mjs',
			'export const pages = [async () => ({ default: 1 })];\n',
		);
		const render = await createRenderer(CONTEXT, await runtimeUrl());

		await expect(
			render({ page: 0, main: chunk, entry: 0, layout: null, content: null }),
		).rejects.toThrow(
			/Failed to render \/s\/a\.tsx: a page must export a component as default/,
		);
		await expect(
			render({ page: 0, main: chunk, entry: 5, layout: null, content: null }),
		).rejects.toThrow(/Failed to render \/s\/a\.tsx: the chunk .* has no page 5/);
	});

	test('an html page is wrapped by its layout with its body as the content', async () => {
		const layout = await write(
			'layout.mjs',
			'export default (p) => `<main>${p.content}</main>`;\n',
		);
		const render = await createRenderer(CONTEXT, await runtimeUrl());

		expect(await render({ page: 0, main: null, layout, content: '<p>body</p>' })).toEqual(
			[0, '<main><p>body</p></main>'],
		);
	});
});
