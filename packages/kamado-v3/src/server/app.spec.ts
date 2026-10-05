import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const serveRequest =
	vi.fn<(handle: string, urlPath: string, rendererStarted: '0' | '1') => string>();
const serveFinishRender = vi.fn<(handle: string, token: string, html: string) => string>();
const serveFinishScript = vi.fn<(handle: string, token: string, output: string) => string>();
const serveClose = vi.fn<(handle: string) => void>();
const buildScripts = vi.fn<(request: unknown) => Promise<unknown[]>>();

vi.mock('../native.js', () => ({
	native: () => ({ serveRequest, serveFinishRender, serveFinishScript, serveClose }),
}));
vi.mock('../scripts.js', () => ({
	buildScripts: (request: unknown) => buildScripts(request),
}));

const { createApp } = await import('./app.js');

const DESCRIPTION = {
	handle: 'h1',
	devServer: { port: 3000, host: 'localhost', open: false, startPath: '/', proxy: {} },
	inputDir: '/s',
	outputDir: '/o',
};

/**
 * A renderer that records what it was asked and answers with fixed HTML.
 * @param html - What every render returns
 */
function fakeRenderer(html = '<p>rendered</p>') {
	const calls: string[] = [];
	let started = false;
	return {
		calls,
		get started() {
			return started;
		},
		start: vi.fn((context: unknown) => {
			started = true;
			calls.push(`start ${JSON.stringify(context)}`);
		}),
		update: vi.fn((update: unknown) => {
			calls.push(`update ${JSON.stringify(update)}`);
		}),
		render: vi.fn((job: { page: number }) => {
			calls.push(`render ${job.page}`);
			return Promise.resolve(html);
		}),
		close: vi.fn(() => Promise.resolve()),
	};
}

describe('createApp', () => {
	let dir = '';

	beforeEach(async () => {
		dir = await mkdtemp(path.join(tmpdir(), 'kamado-app-'));
		serveRequest.mockReset();
		serveFinishRender.mockReset();
		serveFinishScript.mockReset();
		serveClose.mockReset();
		buildScripts.mockReset();
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test('a ready body is sent with its content type', async () => {
		serveRequest.mockReturnValue(
			JSON.stringify({ kind: 'text', contentType: 'text/html', body: '<p>x</p>' }),
		);
		const { app } = createApp(DESCRIPTION, 'file:///rt.js', { renderer: fakeRenderer() });

		const response = await app.request('/about/?q=1');

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
		expect(await response.text()).toBe('<p>x</p>');
		expect(serveRequest).toHaveBeenCalledExactlyOnceWith('h1', '/about/', '0');
	});

	test('a file is streamed with its type and size', async () => {
		const file = path.join(dir, 'logo.svg');
		await writeFile(file, '<svg/>');
		serveRequest.mockReturnValue(JSON.stringify({ kind: 'file', path: file }));
		const { app } = createApp(DESCRIPTION, 'file:///rt.js', { renderer: fakeRenderer() });

		const response = await app.request('/logo.svg');

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('image/svg+xml');
		expect(response.headers.get('content-length')).toBe('6');
		expect(await response.text()).toBe('<svg/>');
	});

	test('a file that vanished is a 404', async () => {
		serveRequest.mockReturnValue(
			JSON.stringify({ kind: 'file', path: path.join(dir, 'gone.png') }),
		);
		const { app } = createApp(DESCRIPTION, 'file:///rt.js', { renderer: fakeRenderer() });

		const response = await app.request('/gone.png');

		expect(response.status).toBe(404);
	});

	test('forbidden and not found are passed on', async () => {
		const { app } = createApp(DESCRIPTION, 'file:///rt.js', { renderer: fakeRenderer() });

		serveRequest.mockReturnValueOnce(JSON.stringify({ kind: 'forbidden' }));
		const forbidden = await app.request('/x');
		serveRequest.mockReturnValueOnce(JSON.stringify({ kind: 'notFound' }));
		const missing = await app.request('/y');

		expect([forbidden.status, await forbidden.text()]).toEqual([403, 'Forbidden']);
		expect(missing.status).toBe(404);
	});

	test('a page to render starts the renderer with the context, renders and hands the HTML back', async () => {
		const renderer = fakeRenderer();
		serveRequest.mockReturnValue(
			JSON.stringify({
				kind: 'render',
				token: '5',
				job: { page: 3, main: '/m.mjs', layout: null, content: null },
				restart: false,
				context: { pages: [] },
				update: null,
			}),
		);
		serveFinishRender.mockReturnValue(
			JSON.stringify({ kind: 'text', contentType: 'text/html', body: '<p>done</p>\n' }),
		);
		const { app } = createApp(DESCRIPTION, 'file:///rt.js', { renderer });

		const response = await app.request('/page.html');

		expect(await response.text()).toBe('<p>done</p>\n');
		expect(renderer.calls).toEqual(['start {"pages":[]}', 'render 3']);
		expect(serveFinishRender).toHaveBeenCalledExactlyOnceWith('h1', '5', '<p>rendered</p>');
		// The next request tells the core the renderer is there.
		serveRequest.mockReturnValue(JSON.stringify({ kind: 'notFound' }));
		await app.request('/other');
		expect(serveRequest).toHaveBeenLastCalledWith('h1', '/other', '1');
	});

	test('an update goes to the renderer before the job, and a restart starts a new one', async () => {
		const renderer = fakeRenderer();
		const render = (extra: Record<string, unknown>) =>
			JSON.stringify({
				kind: 'render',
				token: '1',
				job: { page: 0, main: null, layout: null, content: '' },
				restart: false,
				context: null,
				update: null,
				...extra,
			});
		serveFinishRender.mockReturnValue(
			JSON.stringify({ kind: 'text', contentType: 'text/html', body: '' }),
		);
		const { app } = createApp(DESCRIPTION, 'file:///rt.js', { renderer });

		serveRequest.mockReturnValueOnce(render({ context: { pages: [1] }, restart: true }));
		await app.request('/a');
		serveRequest.mockReturnValueOnce(render({ update: { pages: [[0, 'p']], data: null } }));
		await app.request('/b');
		serveRequest.mockReturnValueOnce(render({ restart: true, context: { pages: [2] } }));
		await app.request('/c');

		expect(renderer.calls).toEqual([
			'start {"pages":[1]}',
			'render 0',
			'update {"pages":[[0,"p"]],"data":null}',
			'render 0',
			'start {"pages":[2]}',
			'render 0',
		]);
	});

	test('a script is built by esbuild and handed back', async () => {
		const request = { root: '/s', options: {}, entries: [{ id: 0 }] };
		serveRequest.mockReturnValue(JSON.stringify({ kind: 'script', token: '9', request }));
		buildScripts.mockResolvedValue([{ id: 0, code: 'a();', inputs: ['/s/a.ts'] }]);
		serveFinishScript.mockReturnValue(
			JSON.stringify({ kind: 'text', contentType: 'text/javascript', body: 'a();' }),
		);
		const { app } = createApp(DESCRIPTION, 'file:///rt.js', { renderer: fakeRenderer() });

		const response = await app.request('/a.js');

		expect(await response.text()).toBe('a();');
		expect(buildScripts).toHaveBeenCalledExactlyOnceWith(request);
		expect(serveFinishScript).toHaveBeenCalledExactlyOnceWith(
			'h1',
			'9',
			'{"code":"a();","inputs":["/s/a.ts"]}',
		);
	});

	test('an error is a 500 with its message and is logged', async () => {
		serveRequest.mockImplementation(() => {
			throw new Error('/s/index.tsx:3:5: unexpected token');
		});
		const logs: unknown[] = [];
		const { app } = createApp(DESCRIPTION, 'file:///rt.js', {
			renderer: fakeRenderer(),
			onRequest: (log) => logs.push(log),
		});

		const response = await app.request('/index.html');

		expect(response.status).toBe(500);
		expect(await response.text()).toBe('/s/index.tsx:3:5: unexpected token');
		expect(logs).toEqual([
			{
				pathname: '/index.html',
				status: 500,
				kind: 'error',
				ms: expect.any(Number),
				error: '/s/index.tsx:3:5: unexpected token',
			},
		]);
	});

	test('a render that fails in the worker is a 500 with the message of the page', async () => {
		const renderer = fakeRenderer();
		renderer.render.mockRejectedValue(new Error('Failed to render /s/a.tsx: boom'));
		serveRequest.mockReturnValue(
			JSON.stringify({
				kind: 'render',
				token: '1',
				job: { page: 0, main: '/m.mjs', layout: null, content: null },
				restart: false,
				context: { pages: [] },
				update: null,
			}),
		);
		const { app } = createApp(DESCRIPTION, 'file:///rt.js', { renderer });

		const response = await app.request('/a.html');

		expect(response.status).toBe(500);
		expect(await response.text()).toBe('Failed to render /s/a.tsx: boom');
		expect(serveFinishRender).not.toHaveBeenCalled();
	});

	test('the proxy is registered before the routes of the site', async () => {
		const fakeFetch = vi.fn(() => Promise.resolve(new Response('proxied')));
		const { app } = createApp(
			{
				...DESCRIPTION,
				devServer: { ...DESCRIPTION.devServer, proxy: { '/api': 'http://backend.test' } },
			},
			'file:///rt.js',
			{ renderer: fakeRenderer(), fetch: fakeFetch as unknown as typeof fetch },
		);

		const response = await app.request('/api/x');

		expect(await response.text()).toBe('proxied');
		expect(serveRequest).not.toHaveBeenCalled();
	});

	test('closing stops the renderer and forgets the server in the core', async () => {
		const renderer = fakeRenderer();
		const { close } = createApp(DESCRIPTION, 'file:///rt.js', { renderer });

		await close();

		expect(renderer.close).toHaveBeenCalledOnce();
		expect(serveClose).toHaveBeenCalledExactlyOnceWith('h1');
	});
});
