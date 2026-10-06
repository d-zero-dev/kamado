/**
 * The HTTP side of the dev server (RFC section 12). The core decides what a
 * path turns into; this module turns that into responses, and does the
 * round trips the core asks for: rendering a page in the worker, building a
 * script with esbuild.
 */
import type { RenderContext } from '../props.js';
import type { RenderJob } from '../render.js';
import type { ScriptRequest } from '../scripts.js';
import type { ContextUpdate } from './context-update.js';
import type { ProxyRule } from './proxy.js';

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

import { Hono } from 'hono';

import { native } from '../native.js';
import { buildScripts } from '../scripts.js';

import { contentTypeOf } from './mime.js';
import { setProxyRoutes } from './proxy.js';
import { ServeRenderer } from './renderer.js';

/** What the core answers to a request. */
export type Answer =
	| { readonly kind: 'text'; readonly contentType: string; readonly body: string }
	| { readonly kind: 'file'; readonly path: string }
	| { readonly kind: 'forbidden' }
	| { readonly kind: 'notFound' }
	| {
			readonly kind: 'render';
			readonly token: string;
			readonly job: RenderJob;
			readonly restart: boolean;
			readonly context: RenderContext | null;
			readonly update: ContextUpdate | null;
	  }
	| { readonly kind: 'script'; readonly token: string; readonly request: ScriptRequest };

/** What `serveOpen` reports about the project. */
export interface ServeDescription {
	readonly handle: string;
	readonly devServer: {
		readonly port: number;
		readonly host: string;
		readonly open: boolean;
		readonly startPath: string;
		readonly proxy: Readonly<Record<string, string | ProxyRule>>;
	};
	readonly inputDir: string;
	readonly outputDir: string;
}

/** What a request ended as, for the log. */
export interface RequestLog {
	readonly pathname: string;
	readonly status: number;
	readonly ms: number;
	/** `page`, `style`, `script` or `file`. */
	readonly kind: string;
	readonly error?: string;
}

/** What the app needs of a renderer (see `ServeRenderer`). */
export type Renderer = Pick<
	ServeRenderer,
	'close' | 'render' | 'start' | 'started' | 'update'
>;

/** Options of {@link createApp}. */
export interface AppOptions {
	/** Called once per request when it is done. */
	readonly onRequest?: (log: RequestLog) => void;
	/** `fetch` for the proxy, replaceable for tests. */
	readonly fetch?: typeof fetch;
	/** The renderer of pages, replaceable for tests. */
	readonly renderer?: Renderer;
}

/**
 * Creates the application. The caller serves `app.fetch` and calls `close`
 * when it stops.
 * @param description - What `serveOpen` returned
 * @param runtimeUrl - File URL of the JSX runtime
 * @param options - Logging and test hooks
 * @returns The Hono app and a function that releases the renderer and the core
 * @example
 * ```ts
 * const { app, close } = createApp(description, runtimeUrl);
 * serve({ fetch: app.fetch, port: description.devServer.port });
 * ```
 */
export function createApp(
	description: ServeDescription,
	runtimeUrl: string,
	options: AppOptions = {},
): { readonly app: Hono; readonly close: () => Promise<void> } {
	const core = native();
	const { handle } = description;
	const renderer: Renderer = options.renderer ?? new ServeRenderer(runtimeUrl);
	const app = new Hono();
	setProxyRoutes(app, description.devServer.proxy, options.fetch);

	/**
	 * Asks the core and does what it asks until there is something to send.
	 * @param pathname - The path of the request
	 */
	const answer = async (pathname: string): Promise<{ answer: Answer; kind: string }> => {
		let current = JSON.parse(
			core.serveRequest(handle, pathname, renderer.started ? '1' : '0'),
		) as Answer;
		let kind = 'file';
		switch (current.kind) {
			case 'render': {
				kind = 'page';
				// The context or its update is sent before the job, in the order the
				// core produced them: concurrent requests must not reorder them. The
				// core sends the whole context whenever the renderer has to start.
				if (current.context) {
					renderer.start(current.context);
				} else if (current.update) {
					renderer.update(current.update);
				}
				const html = await renderer.render(current.job);
				current = JSON.parse(
					core.serveFinishRender(handle, current.token, html),
				) as Answer;

				break;
			}
			case 'script': {
				kind = 'script';
				const [built] = await buildScripts(current.request);
				current = JSON.parse(
					core.serveFinishScript(
						handle,
						current.token,
						JSON.stringify({ code: built!.code, inputs: built!.inputs }),
					),
				) as Answer;

				break;
			}
			case 'text': {
				kind = current.contentType === 'text/css' ? 'style' : 'page';

				break;
			}
			// No default
		}
		return { answer: current, kind };
	};

	app.get('*', async (ctx) => {
		const started = performance.now();
		const { pathname } = new URL(ctx.req.url);
		const log = (status: number, kind: string, error?: string) =>
			options.onRequest?.({
				pathname,
				status,
				kind,
				ms: Math.round(performance.now() - started),
				...(error === undefined ? {} : { error }),
			});
		try {
			const { answer: result, kind } = await answer(pathname);
			switch (result.kind) {
				case 'text': {
					log(200, kind);
					return ctx.body(result.body, 200, {
						'Content-Type': `${result.contentType}; charset=utf-8`,
					});
				}
				case 'file': {
					const info = await stat(result.path).catch(() => null);
					if (!info?.isFile()) {
						log(404, 'file');
						return ctx.notFound();
					}
					log(200, 'file');
					return ctx.body(
						Readable.toWeb(createReadStream(result.path)) as ReadableStream,
						200,
						{
							'Content-Type': contentTypeOf(result.path),
							'Content-Length': String(info.size),
						},
					);
				}
				case 'forbidden': {
					log(403, kind);
					return ctx.text('Forbidden', 403);
				}
				case 'notFound': {
					log(404, kind);
					return ctx.notFound();
				}
				default: {
					throw new Error(`unexpected answer from the core: ${result.kind}`);
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log(500, 'error', message);
			return ctx.text(message, 500);
		}
	});

	return {
		app,
		close: async () => {
			await renderer.close();
			core.serveClose(handle);
		},
	};
}
