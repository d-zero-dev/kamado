import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import http from 'node:http';
import net from 'node:net';

import { afterEach, describe, expect, test } from 'vitest';

import { close, urlHost, listen, listenAddresses } from './listen.js';

describe('listenAddresses', () => {
	test.each(['localhost', 'LocalHost', 'localhost.'])(
		'%s is listened on at both loopback addresses',
		(host) => {
			expect(listenAddresses(host)).toStrictEqual(['127.0.0.1', '::1']);
		},
	);

	test.each(['127.0.0.1', '::1', '0.0.0.0', 'laptop.example.test', 'sub.localhost'])(
		'%s is listened on as written',
		(host) => {
			expect(listenAddresses(host)).toStrictEqual([host]);
		},
	);

	test('an IPv6 address in brackets is listened on without them', () => {
		expect(listenAddresses('[::1]')).toStrictEqual(['::1']);
	});
});

describe('urlHost', () => {
	test.each([
		['localhost', 'localhost'],
		['127.0.0.1', '127.0.0.1'],
		['0.0.0.0', '0.0.0.0'],
		['laptop.example.test', 'laptop.example.test'],
		['::1', '[::1]'],
		['::', '[::]'],
		['[::1]', '[::1]'],
	])('%s is written %s in a URL', (host, expected) => {
		expect(urlHost(host)).toBe(expected);
	});
});

describe('listen', () => {
	const opened: Server[] = [];
	afterEach(async () => {
		await Promise.all(opened.splice(0).map((server) => close(server)));
	});

	/**
	 * Whether the machine has `address` (`::1` is missing where IPv6 is off).
	 * @param address - An IP address
	 */
	function has(address: string): Promise<boolean> {
		const server = http.createServer();
		return new Promise((resolve) => {
			server.once('error', () => resolve(false));
			server.listen(0, address, () => {
				server.close(() => resolve(true));
			});
		});
	}

	/**
	 * A server for each listened address, answering with that address.
	 * @param address - The address it listens on
	 */
	function createServer(address: string): Server {
		const server = http.createServer((_, res) => {
			res.end(address);
		});
		opened.push(server);
		return server;
	}

	/**
	 * GETs `/` of `host:port`.
	 * @param host - An IP address
	 * @param port - The port
	 */
	function get(host: string, port: number): Promise<string> {
		return new Promise((resolve, reject) => {
			http
				.get({ host, port, path: '/' }, (res) => {
					let body = '';
					res.setEncoding('utf8');
					res.on('data', (chunk: string) => (body += chunk));
					res.on('end', () => resolve(body));
				})
				.on('error', reject);
		});
	}

	/**
	 * Opens a server on `address` with a free port, to hold it.
	 * @param address - The address
	 */
	async function occupy(address: string): Promise<number> {
		const server = createServer(address);
		await new Promise<void>((resolve) => {
			server.listen(0, address, resolve);
		});
		return (server.address() as AddressInfo).port;
	}

	test('every address is reachable on one port', async () => {
		const expected = (await has('::1')) ? ['127.0.0.1', '::1'] : ['127.0.0.1'];
		const servers = await listen(createServer, ['127.0.0.1', '::1'], 0);
		const port = (servers[0]!.address() as AddressInfo).port;
		expect(servers.map((server) => server.address())).toStrictEqual(
			expected.map((address) => expect.objectContaining({ address, port })),
		);
		for (const address of expected) {
			await expect(get(address, port)).resolves.toBe(address);
		}
	});

	test('an address the machine does not have is skipped', async () => {
		// 192.0.2.1 is TEST-NET-1 (RFC 5737), assigned to no interface. Linux
		// with `net.ipv4.ip_nonlocal_bind=1` would let it be listened on.
		const servers = await listen(createServer, ['127.0.0.1', '192.0.2.1'], 0);
		expect(servers).toHaveLength(1);
		expect((servers[0]!.address() as AddressInfo).address).toBe('127.0.0.1');
	});

	test('no address the machine has is the error of the first one', async () => {
		await expect(
			listen(createServer, ['192.0.2.1', '192.0.2.2'], 0),
		).rejects.toMatchObject({ code: 'EADDRNOTAVAIL', address: '192.0.2.1' });
	});

	test('an address family the machine does not support is skipped', async () => {
		const servers = await listen(
			(address) => {
				const server = createServer(address);
				if (address === '::1') {
					server.listen = () => {
						process.nextTick(() => {
							server.emit(
								'error',
								Object.assign(new Error('not supported'), { code: 'EAFNOSUPPORT' }),
							);
						});
						return server;
					};
				}
				return server;
			},
			['127.0.0.1', '::1'],
			0,
		);
		expect(
			servers.map((server) => (server.address() as AddressInfo).address),
		).toStrictEqual(['127.0.0.1']);
	});

	test('no address at all is an error', async () => {
		await expect(listen(createServer, [], 0)).rejects.toThrow('no address to listen on');
	});

	test('a port in use on the first address fails before the next is made', async () => {
		const port = await occupy('127.0.0.1');
		const created: string[] = [];
		await expect(
			listen(
				(address) => {
					created.push(address);
					return createServer(address);
				},
				['127.0.0.1', '::1'],
				port,
			),
		).rejects.toMatchObject({ code: 'EADDRINUSE', address: '127.0.0.1', port });
		expect(created).toStrictEqual(['127.0.0.1']);
	});

	test('a port in use on one address fails and closes what was opened', async () => {
		const port = await occupy('127.0.0.1');
		const created: Server[] = [];
		await expect(
			listen(
				(address) => {
					const server = createServer(address);
					created.push(server);
					return server;
				},
				['::1', '127.0.0.1'],
				port,
			),
		).rejects.toMatchObject({ code: 'EADDRINUSE', address: '127.0.0.1', port });
		expect(created).toHaveLength(2);
		expect(created.map((server) => server.listening)).toStrictEqual([false, false]);
	});
});

describe('close', () => {
	/**
	 * A listening server with one request in progress that never ends (a
	 * proxied event stream).
	 */
	async function withOpenRequest(): Promise<{ server: Server; ended: Promise<void> }> {
		const server = http.createServer((_, res) => {
			res.writeHead(200);
			res.write('event');
		});
		await new Promise<void>((resolve) => {
			server.listen(0, '127.0.0.1', resolve);
		});
		const { port } = server.address() as AddressInfo;
		const ended = new Promise<void>((resolve) => {
			http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
				res.resume();
				res.on('close', resolve);
			});
		});
		await new Promise<void>((resolve) => {
			server.once('request', () => resolve());
		});
		return { server, ended };
	}

	test('with force, a request in progress is cut and the server closes', async () => {
		const { server, ended } = await withOpenRequest();
		await close(server, true);
		expect(server.listening).toBe(false);
		await ended;
	});

	test('force on a server that is not an http.Server rejects', async () => {
		await expect(close(net.createServer(), true)).rejects.toThrow(TypeError);
	});

	test('without force, the server waits for a request in progress', async () => {
		const { server, ended } = await withOpenRequest();
		let closed = false;
		const closing = close(server).then(() => (closed = true));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(closed).toBe(false);
		server.closeAllConnections();
		await closing;
		await ended;
	});
});
