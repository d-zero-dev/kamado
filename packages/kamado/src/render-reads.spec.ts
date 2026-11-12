import type { RenderContext } from './props.js';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createRenderer, renderJobs, resetInlineRendering } from './render.js';

let dir = '';

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'kamado-reads-'));
	resetInlineRendering();
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const page = (url: string) => ({
	url,
	inputPath: `/s${url}.tsx`,
	outputPath: `/o${url}/index.html`,
	fileSlug: 'x',
	filePathStem: `${url}/index`,
	extension: '.html',
	date: '2026-01-01T00:00:00.000Z',
	meta: {},
});

const CONTEXT = {
	site: {
		host: null,
		baseURL: null,
		siteName: null,
		siteNameEn: null,
		name: null,
		version: null,
	},
	data: { posts: 'P', news: 'N' },
	pages: [page('/a'), page('/b')],
} as unknown as RenderContext;

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
		'export const render = (component, props) => String(component(props));\n' +
			'export const html = (text) => ({ toString: () => text });\n',
	);
	return pathToFileURL(file).href;
}

type Reads = [number, readonly string[] | null][];

describe('the data a page reads', () => {
	test('is reported per page: only the keys the page and its layout read', async () => {
		const main = await write('a.mjs', 'export default (p) => p.data.posts;\n');
		const layout = await write(
			'l.mjs',
			'export default (p) => p.content + p.data.news;\n',
		);
		const reads: Reads = [];
		const render = await createRenderer(CONTEXT, await runtimeUrl(), (page, keys) =>
			reads.push([page, keys]),
		);

		await render({ page: 0, main, layout, content: null });

		expect(reads).toEqual([[0, ['posts', 'news']]]);
	});

	test('a page that lists the keys depends on every key (null)', async () => {
		const main = await write(
			'a.mjs',
			'export default (p) => Object.keys(p.data).join();\n',
		);
		const reads: Reads = [];
		const render = await createRenderer(CONTEXT, await runtimeUrl(), (page, keys) =>
			reads.push([page, keys]),
		);

		await render({ page: 1, main, layout: null, content: null });

		expect(reads).toEqual([[1, null]]);
	});

	test('a page that throws depends on every key', async () => {
		const main = await write(
			'a.mjs',
			'export default (p) => { void p.data.posts; throw new Error("x"); };\n',
		);
		const reads: Reads = [];
		const render = await createRenderer(CONTEXT, await runtimeUrl(), (page, keys) =>
			reads.push([page, keys]),
		);

		await expect(
			render({ page: 0, main, layout: null, content: null }),
		).rejects.toThrow();

		expect(reads).toEqual([[0, null]]);
	});

	test('reaches renderJobs when the pages are rendered in this thread', async () => {
		const main = await write('a.mjs', 'export default (p) => p.data.posts;\n');
		const jobs = Array.from({ length: 4 }, (_, i) => ({
			page: i % 2,
			main,
			layout: null,
			content: null,
		}));
		const reads: Reads = [];

		await renderJobs(jobs, CONTEXT, {
			runtimeUrl: await runtimeUrl(),
			parallelism: 1,
			onRendered: () => {},
			onReads: (r) => reads.push(...r),
		});

		expect(reads).toHaveLength(4);
		expect(reads.every(([, keys]) => keys?.join(',') === 'posts')).toBe(true);
	});
});
