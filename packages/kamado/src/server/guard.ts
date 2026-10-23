/**
 * Refuses the requests a dev server should not answer: those of a browser
 * whose DNS was rebound to it (the attacker's domain resolves to 127.0.0.1,
 * so their page reads the sources, the source maps and what the proxy
 * reaches), and those another site makes to it (a `<script src>` of a bundle,
 * a form that posts through the proxy, an `<iframe>` that frames it, a link
 * to a proxied API).
 *
 * Two checks, before any route: the host the request names is one the server
 * is meant for, and the request is not cross-site. The second one reads the
 * fetch metadata (`Sec-Fetch-*`, https://www.w3.org/TR/fetch-metadata/),
 * which a page cannot forge, and `Origin`: a browser counts `127.0.0.1` and
 * `localhost` as two sites, so a cross-site request whose `Origin` is this
 * machine (another tool of the developer) is served. `Origin` alone would
 * not do: it is not sent on a plain GET, which is what `<script src>` makes.
 * A client that sends none of them (curl, a crawler) is not a browser
 * carrying another site's credentials, and passes.
 *
 * Browsers send the fetch metadata only to potentially trustworthy URLs
 * (`https:`, `localhost`, the loopback), so on a plain-http host that is not
 * the loopback (`http://192.168.1.5:3000`, `http://laptop.local:3000`) the
 * second check sees `Origin` alone and cannot refuse a GET; the first check
 * still holds there.
 */
import type { RequestLog } from './app.js';
import type { Hono } from 'hono';

import { isIP } from 'node:net';

/** What the guard reads of `devServer`. */
export interface GuardedServer {
	/** The address the server listens on. */
	readonly host: string;
	/** Host names to serve besides `localhost`, IP literals and `host`. */
	readonly allowedHosts: readonly string[];
	/** The proxy rules, by path prefix. */
	readonly proxy: Readonly<Record<string, unknown>>;
}

/** The config as the guard compares it: computed once, used for every request. */
export interface Guard {
	/** `devServer.host`, normalized (an IP address as the URL parser writes it). */
	readonly host: string;
	/** `devServer.allowedHosts`, normalized the same way. */
	readonly allowedHosts: readonly string[];
	/** The path prefixes of `devServer.proxy`, without a trailing slash. */
	readonly proxyPrefixes: readonly string[];
}

/** Why a request was refused. */
export type Block =
	| { readonly reason: 'host'; readonly hostname: string }
	| {
			readonly reason: 'cross-site';
			/** The `Origin` header, or `null` when absent. */
			readonly origin: string | null;
			/** The `Sec-Fetch-Dest` header, or `null` when absent. */
			readonly dest: string | null;
	  };

/** What `blockReason` reads of a request. */
export interface GuardedRequest {
	/** The host name of the URL, without the port (`[::1]` for IPv6). */
	readonly hostname: string;
	/** The path of the URL. */
	readonly pathname: string;
	readonly method: string;
	readonly headers: Pick<Headers, 'get'>;
}

/**
 * A host name as compared: lower case, without the trailing dot of a fully
 * qualified name and without the brackets of an IPv6 address.
 * @param hostname - A host name
 */
function normalizeHost(hostname: string): string {
	return hostname
		.toLowerCase()
		.replace(/\.$/, '')
		.replace(/^\[(.*)\]$/, '$1');
}

/**
 * The address of a normalized host name that is an IP literal, else `null`.
 * @param name - A normalized host name
 */
function ipOf(name: string): string | null {
	return isIP(name) === 0 ? null : name;
}

/**
 * Whether an address is the loopback. The URL parser writes an IPv4-mapped
 * address in hex (`::ffff:7f00:1` for `::ffff:127.0.0.1`).
 * @param ip - An IP address
 */
function isLoopback(ip: string): boolean {
	return ip === '::1' || ip.startsWith('127.') || /^::ffff:7f[\da-f]{2}:/.test(ip);
}

/**
 * A host name of the config as the URL parser would write it in a request:
 * an IP address in its canonical form (`0:0:0:0:0:0:0:1` is `::1`), so that
 * it compares equal to the host name of a request or an `Origin`.
 * @param hostname - A host name of the config
 */
function canonicalHost(hostname: string): string {
	const name = normalizeHost(hostname);
	const ip = ipOf(name);
	if (ip === null) {
		return name;
	}
	try {
		return normalizeHost(new URL(`http://${isIP(ip) === 6 ? `[${ip}]` : ip}/`).hostname);
	} catch {
		return name;
	}
}

/**
 * Prepares the guard of a server: the host names are normalized once.
 * @param devServer - `host`, `allowedHosts` and `proxy` of the config
 * @example
 * ```ts
 * prepareGuard({ host: 'Laptop.local', allowedHosts: ['[0:0:0:0:0:0:0:1]'], proxy: { '/api/': 'http://backend.test' } });
 * // { host: 'laptop.local', allowedHosts: ['::1'], proxyPrefixes: ['/api'] }
 * ```
 */
export function prepareGuard(devServer: GuardedServer): Guard {
	return {
		host: canonicalHost(devServer.host),
		allowedHosts: devServer.allowedHosts.map((host) => canonicalHost(host)),
		// `/api/` forwards `/api/` and what is under it, which `/api` covers too.
		proxyPrefixes: Object.keys(devServer.proxy).map((prefix) =>
			prefix.replace(/\/+$/, ''),
		),
	};
}

/**
 * Whether a normalized host name is `devServer.host` or an entry of
 * `devServer.allowedHosts` (`.example.test` matches `example.test` and every
 * subdomain of it).
 * @param name - A normalized host name
 * @param guard - The prepared config
 */
function isConfigured(name: string, guard: Guard): boolean {
	return (
		name === guard.host ||
		guard.allowedHosts.some((pattern) =>
			pattern.startsWith('.')
				? name === pattern.slice(1) || name.endsWith(pattern)
				: name === pattern,
		)
	);
}

/**
 * Whether a request for `hostname` is for this server. `localhost` and its
 * subdomains resolve to the loopback (RFC 6761), and an IP literal cannot be
 * rebound; the rest is what the config names.
 * @param hostname - The host name of the request, without the port
 * @param guard - The prepared config
 * @example
 * ```ts
 * const guard = prepareGuard({ host: 'localhost', allowedHosts: ['.example.test'], proxy: {} });
 * isAllowedHost('app.localhost', guard); // true
 * isAllowedHost('a.example.test', guard); // true
 * isAllowedHost('evil.example', guard); // false
 * ```
 */
export function isAllowedHost(hostname: string, guard: Guard): boolean {
	const name = normalizeHost(hostname);
	if (name === 'localhost' || name.endsWith('.localhost')) {
		return true;
	}
	if (ipOf(name) !== null) {
		return true;
	}
	return isConfigured(name, guard);
}

/**
 * Whether the page that made a request is this machine's. Unlike the host of
 * a request, an IP literal here is not safe: a page on a public address has
 * one too. The host of the request itself (the site's own pages, opened by
 * whatever name) and the loopback are this machine; an address or a name the
 * config lists is the developer's.
 * @param origin - The `Origin` header
 * @param requestHost - The host name of the request
 * @param guard - The prepared config
 */
function isAllowedOrigin(origin: string, requestHost: string, guard: Guard): boolean {
	let hostname: string;
	try {
		hostname = new URL(origin).hostname;
	} catch {
		// `Origin: null` (a sandboxed frame, a redirect across sites) and
		// anything else that is not a URL.
		return false;
	}
	const name = normalizeHost(hostname);
	if (name === normalizeHost(requestHost)) {
		return true;
	}
	const ip = ipOf(name);
	if (ip !== null) {
		return isLoopback(ip) || isConfigured(ip, guard);
	}
	return isAllowedHost(name, guard);
}

/**
 * Whether a path is one the proxy forwards.
 * @param pathname - The path of the request
 * @param guard - The prepared config
 */
function isProxied(pathname: string, guard: Guard): boolean {
	return guard.proxyPrefixes.some(
		(prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
	);
}

/**
 * Why a request is refused, or `null` when it is served.
 * @param request - The host name, path, method and headers of the request
 * @param guard - The prepared config
 * @example
 * ```ts
 * const guard = prepareGuard({ host: 'localhost', allowedHosts: [], proxy: {} });
 * const headers = new Headers();
 * blockReason({ hostname: 'localhost', pathname: '/', method: 'GET', headers }, guard); // null
 * blockReason({ hostname: 'evil.example', pathname: '/', method: 'GET', headers }, guard);
 * // { reason: 'host', hostname: 'evil.example' }
 * ```
 */
export function blockReason(request: GuardedRequest, guard: Guard): Block | null {
	if (!isAllowedHost(request.hostname, guard)) {
		return { reason: 'host', hostname: request.hostname };
	}
	const site = request.headers.get('sec-fetch-site');
	const origin = request.headers.get('origin');
	// Any other value, a future one included, is not another site.
	if (site !== null && site !== 'cross-site') {
		return null;
	}
	if (site === null && origin === null) {
		return null;
	}
	const dest = request.headers.get('sec-fetch-dest');
	// Following a link from another site opens the page in a tab (browsers
	// navigate with GET only). Framing it is refused: the other site would
	// not read it, but could lay its own elements over it. A link to a proxied
	// path is refused too: a GET with a side effect on the server behind the
	// proxy must not be one click away.
	const opensInTab =
		site === 'cross-site' &&
		request.headers.get('sec-fetch-mode') === 'navigate' &&
		dest === 'document' &&
		request.method.toUpperCase() === 'GET';
	if (opensInTab && !isProxied(request.pathname, guard)) {
		return null;
	}
	return origin !== null && isAllowedOrigin(origin, request.hostname, guard)
		? null
		: { reason: 'cross-site', origin, dest };
}

/**
 * The body of the 403: what was refused and what the developer can do.
 * @param block - Why the request was refused
 */
function messageOf(block: Block): string {
	if (block.reason === 'host') {
		return (
			`The host "${block.hostname}" is not allowed. ` +
			'Add it to devServer.allowedHosts to serve it (devServer.host is only the address to listen on).'
		);
	}
	return (
		'Cross-site requests to the dev server are not allowed ' +
		`(Origin: ${block.origin ?? 'none'}, Sec-Fetch-Dest: ${block.dest ?? 'none'}). ` +
		'Open the URL from the address bar, or, when the request is from a tool of yours, ' +
		'add the host of its Origin to devServer.allowedHosts.'
	);
}

/**
 * Puts the guard in front of every route. Call it before the routes, the
 * proxy included: a request the guard refuses must not reach the proxied
 * server either.
 * @param app - The application
 * @param devServer - `host`, `allowedHosts` and `proxy` of the config
 * @param onRequest - Called with the log of each refused request
 * @example
 * ```ts
 * const app = new Hono();
 * setGuard(app, description.devServer, (log) => console.log(log));
 * setProxyRoutes(app, description.devServer.proxy);
 * ```
 */
export function setGuard(
	app: Hono,
	devServer: GuardedServer,
	onRequest?: (log: RequestLog) => void,
): void {
	const guard = prepareGuard(devServer);
	app.use('*', async (ctx, next) => {
		const started = performance.now();
		// `@hono/node-server` builds the URL from the `Host` header (its
		// `hostname` option, `devServer.host`, when there is none), so this is
		// the host the browser asked for.
		const url = new URL(ctx.req.url);
		const block = blockReason(
			{
				hostname: url.hostname,
				// The path as Hono routes it (percent-decoded), so that the proxy
				// cannot match a path the guard did not see as proxied.
				pathname: ctx.req.path,
				method: ctx.req.method,
				headers: ctx.req.raw.headers,
			},
			guard,
		);
		if (block === null) {
			await next();
			return;
		}
		const message = messageOf(block);
		onRequest?.({
			pathname: url.pathname,
			status: 403,
			kind: 'blocked',
			ms: Math.round(performance.now() - started),
			error: message,
		});
		return ctx.text(message, 403);
	});
}
