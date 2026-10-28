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

import { setGuard } from './guard.js';
import { contentTypeOf } from './mime.js';
import { setProxyRoutes } from './proxy.js';
import { byteRange } from './range.js';
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
		readonly allowedHosts: readonly string[];
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
	/**
	 * `page`, `style`, `script` or `file`; `blocked` for a request the guard
	 * refused, `error` for a 500.
	 */
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
	/**
	 * Opens the server of the project again and returns its handle. Called when
	 * a panic in the native core left the server unusable; without it, that
	 * request and every later one are a 500.
	 */
	readonly reopen?: () => string;
}

/**
 * Whether an error says that a panic left the server of the native core
 * unusable (the core decides it: the call that panicked and every later one
 * on that server have this `code`).
 * @param error - What was thrown
 */
function leftServerUnusable(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error as NodeJS.ErrnoException).code === 'KAMADO_SERVE_POISONED'
	);
}

/**
 * The message of what was thrown.
 * @param error - What was thrown
 */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** How long a failure to open the server again stands before the next try. */
const REOPEN_RETRY_MS = 1000;

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
 * const { host, port } = description.devServer;
 * // `hostname` is where a request without `Host` is taken to be sent.
 * await listen(
 *   () => createAdaptorServer({ fetch: app.fetch, hostname: urlHost(host) }),
 *   listenAddresses(host),
 *   port,
 * );
 * ```
 */
export function createApp(
	description: ServeDescription,
	runtimeUrl: string,
	options: AppOptions = {},
): { readonly app: Hono; readonly close: () => Promise<void> } {
	const core = native();
	// The handle of the server of the core; replaced when a panic left it unusable.
	let server = description.handle;
	const renderer: Renderer = options.renderer ?? new ServeRenderer(runtimeUrl);
	const app = new Hono();
	setGuard(app, description.devServer, options.onRequest);
	setProxyRoutes(app, description.devServer.proxy, options.fetch);

	// The last failure to open the server again, so that the requests of one
	// page (its assets) do not each plan the whole site again.
	let reopenFailure:
		{ readonly used: string; readonly at: number; readonly reason: string } | undefined;

	/**
	 * Opens the server of the core again after `used` was left unusable, once
	 * for all the requests that saw it fail: the first one replaces the handle,
	 * the others find it replaced. The renderer is stopped too, so that the new
	 * server sends it the whole context.
	 * @param used - The handle the failed request used
	 * @throws {Error} when the server cannot be opened (the project's config no
	 *   longer loads, say); the same failure stands for {@link REOPEN_RETRY_MS}
	 */
	const reopen = async (used: string): Promise<void> => {
		if (!options.reopen || server !== used) {
			return;
		}
		if (
			reopenFailure?.used === used &&
			performance.now() - reopenFailure.at < REOPEN_RETRY_MS
		) {
			throw new Error(reopenFailure.reason);
		}
		try {
			server = options.reopen();
		} catch (error) {
			reopenFailure = { used, at: performance.now(), reason: messageOf(error) };
			throw error;
		}
		core.serveClose(used);
		await renderer.close();
	};

	// The handles the core gave up while telling it to forget an answer: the
	// request reports its own error, and is still the one to open the server
	// again.
	const goneWhileCancelling = new Set<string>();

	/**
	 * Tells the core that the JavaScript behind an answer failed. A failure to
	 * tell it is not thrown: the request reports its own failure, and a server
	 * that is gone (closed, or opened again) has nothing to forget. A server
	 * that the telling itself left unusable is remembered for the request.
	 * @param handle - The server the request used
	 * @param token - The token of the answer
	 */
	const cancel = (handle: string, token: string): void => {
		try {
			core.serveCancel(handle, token);
		} catch (error) {
			if (leftServerUnusable(error)) {
				goneWhileCancelling.add(handle);
			}
		}
	};

	/**
	 * Asks the core and does what it asks until there is something to send.
	 * @param pathname - The path of the request
	 * @param handle - The server of the core to ask, the same for the whole request
	 */
	const answer = async (
		pathname: string,
		handle: string,
	): Promise<{ answer: Answer; kind: string }> => {
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
				const { token } = current;
				let html: string;
				try {
					html = await renderer.render(current.job);
				} catch (error) {
					// The core keeps what it needs to finish the page until told.
					cancel(handle, token);
					throw error;
				}
				current = JSON.parse(core.serveFinishRender(handle, token, html)) as Answer;

				break;
			}
			case 'script': {
				kind = 'script';
				const { token } = current;
				let built: Awaited<ReturnType<typeof buildScripts>>[number] | undefined;
				try {
					[built] = await buildScripts(current.request);
				} catch (error) {
					cancel(handle, token);
					throw error;
				}
				current = JSON.parse(
					core.serveFinishScript(
						handle,
						token,
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
		const used = server;
		try {
			const { answer: result, kind } = await answer(pathname, used);
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
					// The files carry no validator (`ETag`, `Last-Modified`), so an
					// `If-Range` cannot be matched: the whole file is sent, as RFC 9110
					// says for one that does not match.
					const range =
						ctx.req.header('If-Range') === undefined
							? byteRange(ctx.req.header('Range'), info.size)
							: null;
					if (range === 'unsatisfiable') {
						log(416, 'file');
						return ctx.body(null, 416, { 'Content-Range': `bytes */${info.size}` });
					}
					const status = range ? 206 : 200;
					log(status, 'file');
					const headers = {
						'Content-Type': contentTypeOf(result.path),
						'Content-Length': String(range ? range.end - range.start + 1 : info.size),
						'Accept-Ranges': 'bytes',
						...(range
							? { 'Content-Range': `bytes ${range.start}-${range.end}/${info.size}` }
							: {}),
					};
					// Hono answers HEAD with this handler and drops the body: a stream
					// opened for it would hold the file open until it is collected.
					if (ctx.req.method === 'HEAD') {
						return ctx.body(null, status, headers);
					}
					return ctx.body(
						Readable.toWeb(createReadStream(result.path, range ?? {})) as ReadableStream,
						status,
						headers,
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
			let message = messageOf(error);
			const gone = leftServerUnusable(error) || goneWhileCancelling.delete(used);
			let notReopened: string | undefined;
			if (gone) {
				try {
					await reopen(used);
				} catch (reopenError) {
					notReopened = messageOf(reopenError);
				}
			}
			if (gone && server !== used) {
				message += '\nThe dev server was opened again; reload the page.';
			} else if (gone && notReopened !== undefined) {
				message += `\nThe dev server could not be opened again: ${notReopened}`;
			} else if (server !== used) {
				// Its own error (a page that throws, say) is what to fix; the server
				// it waited on was replaced meanwhile, which may have cut it short.
				message +=
					'\nMeanwhile the dev server was opened again after a panic in another request.';
			}
			log(500, 'error', message);
			return ctx.text(message, 500);
		}
	});

	return {
		app,
		close: async () => {
			await renderer.close();
			core.serveClose(server);
		},
	};
}
