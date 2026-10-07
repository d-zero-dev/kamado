/**
 * `devServer.proxy`: requests under a path prefix are forwarded to another
 * server (an API during development). The longest prefix wins; the body is
 * streamed both ways; redirects are not followed (the browser follows them);
 * TLS is Node's `fetch`.
 */
import type { Context, Hono } from 'hono';

import { styleText } from 'node:util';

/** A proxy rule as the config gives it. */
export interface ProxyRule {
	/** The server to forward to. */
	readonly target: string;
	/** Rewrites the path with a regular expression before forwarding. */
	readonly rewrite?: { readonly from: string; readonly to: string };
	/** Sends the target's host and origin instead of the browser's. */
	readonly changeOrigin?: boolean;
}

/**
 * Turns the string shorthand into a rule.
 * @param rule - A target URL or a rule
 * @example
 * ```ts
 * normalizeRule('http://localhost:8080'); // { target: 'http://localhost:8080' }
 * ```
 */
export function normalizeRule(rule: string | ProxyRule): ProxyRule {
	return typeof rule === 'string' ? { target: rule } : rule;
}

/**
 * Applies `rewrite` to a path.
 * @param pathname - The path of the request
 * @param rewrite - `from` is a regular expression, `to` its replacement
 * @example
 * ```ts
 * rewritePath('/api/users', { from: '^/api', to: '' }); // '/users'
 * ```
 */
export function rewritePath(pathname: string, rewrite?: ProxyRule['rewrite']): string {
	return rewrite ? pathname.replace(new RegExp(rewrite.from), rewrite.to) : pathname;
}

/**
 * Copies response headers without the ones that describe the body as it was sent
 * (`fetch` has decoded it) and the connection, which would be wrong for what the dev
 * server sends on.
 * @param headers - the headers of the upstream response
 * @example
 * withoutEncodingHeaders(new Headers({ 'content-encoding': 'gzip', 'x-a': '1' })).has('content-encoding'); // false
 */
export function withoutEncodingHeaders(headers: Headers): Headers {
	const copy = new Headers(headers);
	for (const name of ['content-encoding', 'content-length', 'connection', 'keep-alive']) {
		copy.delete(name);
	}
	return copy;
}

/**
 * Whether a method carries a request body.
 * @param method - The HTTP method
 */
export function hasBody(method: string): boolean {
	return !['GET', 'HEAD'].includes(method.toUpperCase());
}

/**
 * Registers the proxy routes. Call it before the routes of the site, so that
 * a proxied path never reaches them.
 * @param app - The application
 * @param proxy - Rules by path prefix
 * @param fetchImpl - `fetch`, replaceable for tests
 * @throws {Error} naming the prefix when a target or a rewrite is invalid
 */
export function setProxyRoutes(
	app: Hono,
	proxy: Readonly<Record<string, string | ProxyRule>>,
	fetchImpl: typeof fetch = fetch,
): void {
	const entries = Object.entries(proxy).toSorted(([a], [b]) => b.length - a.length);
	for (const [prefix, raw] of entries) {
		const rule = normalizeRule(raw);
		let target: URL;
		try {
			target = new URL(rule.target);
			if (rule.rewrite) {
				// Fails now, not on the first request.
				new RegExp(rule.rewrite.from);
			}
		} catch (error) {
			throw new Error(
				`devServer.proxy.${prefix}: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
		const handler = async (ctx: Context) => {
			const requested = new URL(ctx.req.url);
			const forwarded = new URL(rewritePath(requested.pathname, rule.rewrite), target);
			// A rewritten path that starts with `//` is a network-path reference:
			// `new URL('//host/x', target)` would send the request to `host`.
			if (forwarded.origin !== target.origin) {
				return new Response('Bad Request', { status: 400 });
			}
			forwarded.search = requested.search;
			const headers = new Headers(ctx.req.raw.headers);
			if (rule.changeOrigin === true) {
				headers.set('host', target.host);
				headers.set('origin', target.origin);
			}
			try {
				const response = await fetchImpl(forwarded.toString(), {
					method: ctx.req.method,
					headers,
					body: hasBody(ctx.req.method) ? ctx.req.raw.body : undefined,
					// @ts-expect-error -- Node's fetch needs `duplex` to stream a request body
					duplex: hasBody(ctx.req.method) ? 'half' : undefined,
					redirect: 'manual',
				});
				return new Response(response.body, {
					status: response.status,
					statusText: response.statusText,
					headers: withoutEncodingHeaders(response.headers),
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : 'Unknown proxy error';
				// eslint-disable-next-line no-console
				console.error(
					styleText('red', `  Proxy error [${prefix} → ${rule.target}]: ${message}`),
				);
				return ctx.text('Proxy error', 502);
			}
		};
		app.all(`${prefix}/*`, handler);
		app.all(prefix, handler);
	}
}
