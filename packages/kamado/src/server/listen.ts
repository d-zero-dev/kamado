/**
 * Where the dev server listens.
 *
 * Node's `server.listen(port, host)` resolves `host` to one address. For
 * `localhost` that is whichever loopback address the OS lists first (`::1` on
 * macOS), so `http://127.0.0.1:<port>/` would not connect, and another process
 * could take that port on the other address and answer in the server's place.
 * `localhost` is therefore listened on at both loopback addresses, each with
 * its own server on the same port.
 *
 * Why not resolve `localhost`: RFC 6761 §6.3 makes it loopback, and a hosts
 * file that maps it elsewhere would open the server beyond the machine.
 * Why not listen on `::` (both stacks): that is every interface, not loopback.
 */
import type { Server } from 'node:net';

import http from 'node:http';
import { isIPv6 } from 'node:net';

/** The loopback addresses `localhost` is listened on. */
const LOCALHOST = ['127.0.0.1', '::1'];

/**
 * Errors of an address the machine does not have (`::1` where IPv6 is off).
 * Nothing else can listen there either, so skipping it leaves nothing open.
 */
const UNAVAILABLE = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT']);

/**
 * The addresses to listen on for `devServer.host`.
 * @param host - `devServer.host`
 * @returns `127.0.0.1` and `::1` for `localhost` (in any case, with or
 * without the trailing dot), `[host]` for any other host, an IPv6 address
 * without its brackets
 */
export function listenAddresses(host: string): string[] {
	// Not the normalization of the host check: that one may come to take more
	// names than `localhost` itself, which are not to be listened on as it.
	const address = host.replace(/^\[(.*)\]$/, '$1');
	return address.toLowerCase().replace(/\.$/, '') === 'localhost'
		? [...LOCALHOST]
		: [address];
}

/**
 * `devServer.host` as the host of a URL: the start location, and the host a
 * request without `Host` is taken to be sent to (the `hostname` of
 * `@hono/node-server`, which puts it in the URL as is).
 * @param host - `devServer.host`
 * @returns `host`, with an IPv6 address in brackets (`[::1]`), as a URL needs
 */
export function urlHost(host: string): string {
	return isIPv6(host) ? `[${host}]` : host;
}

/**
 * Listens on every address with the same port. An address the machine does
 * not have is skipped; any other error (`EADDRINUSE`) closes what was opened.
 * @param createServer - Makes the server for an address
 * @param addresses - From {@link listenAddresses}
 * @param port - The port (`0` takes a free one, then the rest follow it; a
 * port free on the first address but taken on another fails rather than
 * trying again, as `devServer.port` is never `0` and only tests pass it)
 * @returns The listening servers, at least one
 * @throws {Error} the first error (a `NodeJS.ErrnoException`), when no address could be
 * listened on or one failed otherwise than by not being available
 */
export async function listen<S extends Server>(
	createServer: (address: string) => S,
	addresses: readonly string[],
	port: number,
): Promise<S[]> {
	const servers: S[] = [];
	let skipped: NodeJS.ErrnoException | undefined;
	let at = port;
	for (const address of addresses) {
		const server = createServer(address);
		try {
			await new Promise<void>((resolve, reject) => {
				server.once('error', reject);
				server.listen(at, address, () => {
					server.off('error', reject);
					resolve();
				});
			});
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== undefined && UNAVAILABLE.has(code)) {
				skipped ??= error as NodeJS.ErrnoException;
				continue;
			}
			await Promise.all(servers.map((opened) => close(opened)));
			throw error;
		}
		servers.push(server);
		const bound = server.address();
		if (typeof bound === 'object' && bound !== null) {
			at = bound.port;
		}
	}
	if (servers.length === 0) {
		throw skipped ?? new Error('no address to listen on');
	}
	return servers;
}

/**
 * Stops a server and waits for its connections to end. A server that is not
 * listening (one whose `listen` failed) resolves too: this is the cleanup, and
 * there is nothing left to stop.
 * @param server - A server
 * @param force - Also cut the requests in progress (a proxied event stream
 * never ends by itself, and would keep Ctrl+C from exiting)
 * @returns Resolves when closed; rejects with a `TypeError` with `force` on a
 * server that is not an `http.Server`, which has no way to cut its requests
 */
export function close(server: Server, force = false): Promise<void> {
	const cut = force ? server : undefined;
	if (cut !== undefined && !(cut instanceof http.Server)) {
		// Rejected rather than thrown: the caller maps over servers in a signal
		// handler and waits on the promises.
		return Promise.reject(new TypeError('only an http.Server can cut its requests'));
	}
	const closed = new Promise<void>((resolve) => {
		server.close(() => resolve());
	});
	cut?.closeAllConnections();
	return closed;
}
