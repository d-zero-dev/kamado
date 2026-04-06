import type { ProxyRule } from '../config/types.js';
import type { Context, Hono } from 'hono';

import c from 'ansi-colors';

/**
 * Normalize a proxy rule (string shorthand or ProxyRule object)
 * @param rule - Proxy rule to normalize
 * @returns Normalized ProxyRule object
 */
function normalizeRule(rule: ProxyRule | string): ProxyRule {
	if (typeof rule === 'string') {
		return { target: rule };
	}
	return rule;
}

/**
 * Check if the HTTP method typically carries a request body
 * @param method - HTTP method
 * @returns Whether the method has a body
 */
function hasBody(method: string): boolean {
	return !['GET', 'HEAD'].includes(method.toUpperCase());
}

/**
 * Register proxy routes on the Hono app.
 * Must be called BEFORE setRoute() so proxy routes take priority.
 * @param app - Hono application instance
 * @param proxyConfig - Proxy configuration record
 */
export function setProxyRoutes(
	app: Hono,
	proxyConfig: Readonly<Record<string, ProxyRule | string>>,
): void {
	const sortedEntries = Object.entries(proxyConfig).toSorted(([a], [b]) => b.length - a.length);

	for (const [pathPrefix, rawRule] of sortedEntries) {
		const rule = normalizeRule(rawRule);
		const targetUrl = new URL(rule.target);
		const changeOrigin = rule.changeOrigin === true;

		const handler = async (ctx: Context) => {
			const requestUrl = new URL(ctx.req.url);
			const originalPath = requestUrl.pathname;
			const rewrittenPath = rule.pathRewrite ? rule.pathRewrite(originalPath) : originalPath;

			const proxyUrl = new URL(rewrittenPath, targetUrl);
			proxyUrl.search = requestUrl.search;

			const headers = new Headers(ctx.req.raw.headers);
			if (changeOrigin) {
				headers.set('host', targetUrl.host);
				headers.set('origin', targetUrl.origin);
			}

	
			try {
				const proxyResponse = await fetch(proxyUrl.toString(), {
					method: ctx.req.method,
					headers,
					body: hasBody(ctx.req.method) ? ctx.req.raw.body : undefined,
					// @ts-expect-error -- Node.js fetch supports duplex for streaming request bodies
					duplex: hasBody(ctx.req.method) ? 'half' : undefined,
					redirect: 'manual',
				});

				return new Response(proxyResponse.body, {
					status: proxyResponse.status,
					statusText: proxyResponse.statusText,
					headers: proxyResponse.headers,
				});
			} catch (error) {
				const message =
					error instanceof Error ? error.message : 'Unknown proxy error';
				// eslint-disable-next-line no-console
				console.error(c.red(`  Proxy error [${pathPrefix} → ${rule.target}]: ${message}`));
				return ctx.text('Proxy error', 502);
			}
		};

		app.all(`${pathPrefix}/*`, handler);
		app.all(pathPrefix, handler);
	}
}
