import type * as FS from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createAdaptorServer } from '@hono/node-server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const serveRequest =
	vi.fn<(handle: string, urlPath: string, rendererStarted: '0' | '1') => string>();
const serveFinishRender =
	vi.fn<(handle: string, token: string, html: string) => string>();
const serveFinishScript =
	vi.fn<(handle: string, token: string, output: string) => string>();
const serveCancel = vi.fn<(handle: string, token: string) => string>();
const serveClose = vi.fn<(handle: string) => void>();
const buildScripts = vi.fn<(request: unknown) => Promise<unknown[]>>();

vi.mock('../native.js', () => ({
	native: () => ({
		serveRequest,
		serveFinishRender,
		serveFinishScript,
		serveCancel,
		serveClose,
	}),
}));
vi.mock('../scripts.js', () => ({
	buildScripts: (request: unknown) => buildScripts(request),
}));
// The real one, watched: a HEAD must not open the file.
vi.mock('node:fs', async (importOriginal) => {
	const fs = await importOriginal<typeof FS>();
	return { ...fs, createReadStream: vi.fn(fs.createReadStream) };
});
const { createReadStream } = await import('node:fs');

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
		serveCancel.mockReset();
		serveClose.mockReset();
		buildScripts.mockReset();
		vi.mocked(createReadStream).mockClear();
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

	// `@hono/node-server` fills in `text/plain` for a response without a type,
	// which Firefox will not play as a video (#220), so this goes over real HTTP.
	test('a video is served over HTTP with its type, its size and its parts', async () => {
		const file = path.join(dir, 'clip.mp4');
		await writeFile(file, '0123456789');
		serveRequest.mockReturnValue(JSON.stringify({ kind: 'file', path: file }));
		const { app } = createApp(DESCRIPTION, 'file:///rt.js', { renderer: fakeRenderer() });
		const server = createAdaptorServer({ fetch: app.fetch }) as Server;
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', resolve);
		});
		try {
			const { port } = server.address() as AddressInfo;

			const whole = await fetch(`http://127.0.0.1:${port}/clip.mp4`);
			const part = await fetch(`http://127.0.0.1:${port}/clip.mp4`, {
				headers: { Range: 'bytes=2-5' },
			});

			expect(whole.status).toBe(200);
			expect(whole.headers.get('content-type')).toBe('video/mp4');
			expect(whole.headers.get('content-length')).toBe('10');
			expect(whole.headers.get('accept-ranges')).toBe('bytes');
			expect(await whole.text()).toBe('0123456789');
			expect(part.status).toBe(206);
			expect(part.headers.get('content-type')).toBe('video/mp4');
			expect(part.headers.get('content-length')).toBe('4');
			expect(part.headers.get('content-range')).toBe('bytes 2-5/10');
			expect(await part.text()).toBe('2345');
		} finally {
			// The keep-alive connection of `fetch` would hold `close` for seconds.
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		}
	});

	/** An app whose every request is the ten bytes of `clip.mp4`. */
	async function videoApp() {
		const file = path.join(dir, 'clip.mp4');
		await writeFile(file, '0123456789');
		serveRequest.mockReturnValue(JSON.stringify({ kind: 'file', path: file }));
		return createApp(DESCRIPTION, 'file:///rt.js', { renderer: fakeRenderer() }).app;
	}

	test('a range past the end of a file is a 416 that says the size', async () => {
		const app = await videoApp();

		const response = await app.request('/clip.mp4', { headers: { Range: 'bytes=10-' } });

		expect(response.status).toBe(416);
		expect(response.headers.get('content-range')).toBe('bytes */10');
		expect(await response.text()).toBe('');
	});

	test.each([
		['several ranges', { Range: 'bytes=0-1,4-5' }],
		// No validator is sent, so none can match.
		['a range under If-Range', { Range: 'bytes=0-1', 'If-Range': '"x"' }],
	])('%s is ignored and the whole file is sent', async (_, headers) => {
		const app = await videoApp();

		const response = await app.request('/clip.mp4', { headers });

		expect(response.status).toBe(200);
		expect(response.headers.get('content-range')).toBeNull();
		expect(await response.text()).toBe('0123456789');
	});

	test('a HEAD of a file has its headers and does not open it', async () => {
		const app = await videoApp();

		const response = await app.request('/clip.mp4', {
			method: 'HEAD',
			headers: { Range: 'bytes=2-5' },
		});

		expect(response.status).toBe(206);
		expect(response.headers.get('content-length')).toBe('4');
		expect(response.headers.get('content-range')).toBe('bytes 2-5/10');
		expect(await response.text()).toBe('');
		expect(createReadStream).not.toHaveBeenCalled();
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
		expect(serveFinishRender).toHaveBeenCalledExactlyOnceWith(
			'h1',
			'5',
			'<p>rendered</p>',
		);
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
		serveRequest.mockReturnValueOnce(
			render({ update: { pages: [[0, 'p']], data: null } }),
		);
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
		// The core is told, or it would keep the request for ever.
		expect(serveCancel).toHaveBeenCalledExactlyOnceWith('h1', '1');
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

	/**
	 * An error of the native core with a code.
	 * @param code - `error.code`
	 */
	function coreError(code: string) {
		return Object.assign(new Error(`failed (${code})`), { code });
	}

	describe('after a panic in the native core', () => {
		const page = JSON.stringify({ kind: 'text', contentType: 'text/html', body: 'ok' });

		test('a server the core gave up opens again and the next request uses it', async () => {
			serveRequest.mockImplementation((handle) => {
				if (handle === 'h1') {
					throw coreError('KAMADO_SERVE_POISONED');
				}
				return page;
			});
			const renderer = fakeRenderer();
			const reopen = vi.fn(() => 'h2');
			const { app, close } = createApp(DESCRIPTION, 'file:///rt.js', {
				renderer,
				reopen,
			});

			const failed = await app.request('/a/');
			const next = await app.request('/a/');

			expect(failed.status).toBe(500);
			expect(await failed.text()).toBe(
				'failed (KAMADO_SERVE_POISONED)\nThe dev server was opened again; reload the page.',
			);
			expect(reopen).toHaveBeenCalledOnce();
			expect(serveClose).toHaveBeenCalledExactlyOnceWith('h1');
			// The new server sends the whole context to a renderer started again.
			expect(renderer.close).toHaveBeenCalledOnce();
			expect(next.status).toBe(200);
			expect(serveRequest).toHaveBeenLastCalledWith('h2', '/a/', '0');
			await close();
			expect(serveClose).toHaveBeenLastCalledWith('h2');
		});

		// The core marks the server; a panic outside it (`KAMADO_PANIC` alone)
		// left the server as it was.
		test('another panic does not open the server again', async () => {
			serveRequest.mockImplementation(() => {
				throw coreError('KAMADO_PANIC');
			});
			const reopen = vi.fn(() => 'h2');
			const { app } = createApp(DESCRIPTION, 'file:///rt.js', {
				renderer: fakeRenderer(),
				reopen,
			});

			const response = await app.request('/a/');

			expect(await response.text()).toBe('failed (KAMADO_PANIC)');
			expect(reopen).not.toHaveBeenCalled();
		});

		test('a request that waited on the old server says it was opened again', async () => {
			let rejectRender: (error: Error) => void = () => {};
			const renderer = {
				...fakeRenderer(),
				started: true,
				render: vi.fn(
					() =>
						new Promise<string>((_, reject) => {
							rejectRender = reject;
						}),
				),
				close: vi.fn(() => {
					rejectRender(new Error('the renderer was closed'));
					return Promise.resolve();
				}),
			};
			serveRequest.mockImplementation((_, pathname) => {
				if (pathname === '/b/') {
					throw coreError('KAMADO_SERVE_POISONED');
				}
				return JSON.stringify({
					kind: 'render',
					token: '1',
					job: { page: 0 },
					restart: false,
					context: null,
					update: null,
				});
			});
			// The server it would tell is gone; that is not what the request reports.
			serveCancel.mockImplementation(() => {
				throw new Error('no dev server for handle h1');
			});
			const { app } = createApp(DESCRIPTION, 'file:///rt.js', {
				renderer,
				reopen: () => 'h2',
			});

			const waiting = app.request('/a/');
			await vi.waitFor(() => expect(renderer.render).toHaveBeenCalled());
			await app.request('/b/');
			const response = await waiting;

			expect(await response.text()).toBe(
				'the renderer was closed\nMeanwhile the dev server was opened again after a panic in another request.',
			);
		});

		test('a panic while telling the core to forget an answer opens the server again', async () => {
			serveRequest.mockReturnValue(
				JSON.stringify({
					kind: 'render',
					token: '1',
					job: { page: 0 },
					restart: false,
					context: null,
					update: null,
				}),
			);
			serveCancel.mockImplementation(() => {
				throw coreError('KAMADO_SERVE_POISONED');
			});
			const renderer = {
				...fakeRenderer(),
				started: true,
				render: vi.fn(() => Promise.reject(new Error('the page threw'))),
			};
			const reopen = vi.fn(() => 'h2');
			const { app } = createApp(DESCRIPTION, 'file:///rt.js', { renderer, reopen });

			const response = await app.request('/a/');

			// The page's own error is kept, and the server is opened again.
			expect(await response.text()).toBe(
				'the page threw\nThe dev server was opened again; reload the page.',
			);
			expect(reopen).toHaveBeenCalledOnce();
		});

		test('requests that fail together open it again once', async () => {
			serveRequest.mockImplementation(() => {
				throw coreError('KAMADO_SERVE_POISONED');
			});
			const reopen = vi.fn(() => 'h2');
			const { app } = createApp(DESCRIPTION, 'file:///rt.js', {
				renderer: fakeRenderer(),
				reopen,
			});

			const responses = await Promise.all([app.request('/a/'), app.request('/b/')]);

			expect(responses.map((r) => r.status)).toEqual([500, 500]);
			expect(reopen).toHaveBeenCalledOnce();
		});

		test('an error without the code does not open it again', async () => {
			serveRequest.mockImplementation(() => {
				throw new Error('a page error');
			});
			const reopen = vi.fn(() => 'h2');
			const { app } = createApp(DESCRIPTION, 'file:///rt.js', {
				renderer: fakeRenderer(),
				reopen,
			});

			const response = await app.request('/a/');

			expect(await response.text()).toBe('a page error');
			expect(reopen).not.toHaveBeenCalled();
		});

		test('a server that cannot be opened again says why, and is not tried at once again', async () => {
			vi.useFakeTimers();
			try {
				serveRequest.mockImplementation(() => {
					throw coreError('KAMADO_SERVE_POISONED');
				});
				const reopen = vi.fn(() => {
					throw new Error('kamado.config.jsonc: unknown option');
				});
				const { app } = createApp(DESCRIPTION, 'file:///rt.js', {
					renderer: fakeRenderer(),
					reopen,
				});
				const why =
					'failed (KAMADO_SERVE_POISONED)\nThe dev server could not be opened again: kamado.config.jsonc: unknown option';

				const first = await app.request('/a/');
				const soon = await app.request('/a.css');
				vi.advanceTimersByTime(1000);
				const later = await app.request('/a/');

				expect([first.status, await first.text()]).toEqual([500, why]);
				// The second request says the same without planning the site again.
				expect(await soon.text()).toBe(why);
				expect(await later.text()).toBe(why);
				expect(reopen).toHaveBeenCalledTimes(2);
			} finally {
				vi.useRealTimers();
			}
		});

		test('without a way to open it again the request is a 500', async () => {
			serveRequest.mockImplementation(() => {
				throw coreError('KAMADO_SERVE_POISONED');
			});
			const { app } = createApp(DESCRIPTION, 'file:///rt.js', {
				renderer: fakeRenderer(),
			});

			const response = await app.request('/a/');

			expect(await response.text()).toBe('failed (KAMADO_SERVE_POISONED)');
			expect(serveClose).not.toHaveBeenCalled();
		});
	});
});
