import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import http from 'node:http';

import { createAdaptorServer } from '@hono/node-server';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';

import { blockReason, isAllowedHost, prepareGuard, setGuard } from './guard.js';

const GUARD = prepareGuard({ host: 'localhost', allowedHosts: [], proxy: {} });

describe('prepareGuard', () => {
	test('normalizes the host names and keeps the proxy prefixes', () => {
		expect(
			prepareGuard({
				host: 'Laptop.local.',
				allowedHosts: ['.Example.TEST', 'Tunnel.example', '[::1]', '10.0.0.5'],
				proxy: { '/api': 'http://backend.test', '/img/': { target: 'http://cdn.test' } },
			}),
		).toEqual({
			host: 'laptop.local',
			allowedHosts: ['.example.test', 'tunnel.example', '::1', '10.0.0.5'],
			proxyPrefixes: ['/api', '/img'],
		});
	});

	test('writes IP addresses as the URL parser does', () => {
		expect(
			prepareGuard({
				host: 'FE80:0::1',
				allowedHosts: ['[0:0:0:0:0:0:0:1]', '[::FFFF:10.0.0.5]'],
				proxy: {},
			}),
		).toEqual({
			host: 'fe80::1',
			allowedHosts: ['::1', '::ffff:a00:5'],
			proxyPrefixes: [],
		});
	});
});

describe('isAllowedHost', () => {
	test.each([
		['localhost', true],
		['LOCALHOST.', true],
		['app.localhost', true],
		['127.0.0.1', true],
		['10.0.0.5', true],
		['[::1]', true],
		['[fe80::1]', true],
		['evil.example', false],
		['evil-localhost.example', false],
		['localhost.example', false],
		['127.0.0.1.example', false],
	])('%s with the defaults: %s', (hostname, expected) => {
		expect(isAllowedHost(hostname, GUARD)).toBe(expected);
	});

	test('the host the server listens on is allowed', () => {
		const guard = prepareGuard({ host: 'Laptop.local', allowedHosts: [], proxy: {} });
		expect(isAllowedHost('laptop.local', guard)).toBe(true);
		expect(isAllowedHost('other.local', guard)).toBe(false);
	});

	test.each([
		['laptop.local', true],
		['LAPTOP.LOCAL', true],
		['sub.laptop.local', false],
		['example.test', true],
		['a.example.test', true],
		['a.b.example.test', true],
		['notexample.test', false],
		['example.test.evil', false],
	])(
		'%s with allowedHosts ["laptop.local", ".example.test"]: %s',
		(hostname, expected) => {
			const guard = prepareGuard({
				host: 'localhost',
				allowedHosts: ['laptop.local', '.example.test'],
				proxy: {},
			});
			expect(isAllowedHost(hostname, guard)).toBe(expected);
		},
	);
});

describe('blockReason', () => {
	/**
	 * The arguments of `blockReason` for a request to `localhost`.
	 * @param headers - The headers of the request
	 * @param method - The HTTP method
	 * @param pathname - The path
	 */
	function request(headers: Record<string, string>, method = 'GET', pathname = '/a') {
		return { hostname: 'localhost', pathname, method, headers: new Headers(headers) };
	}

	/**
	 * The refusal of a cross-site request.
	 * @param origin - The `Origin` the request carried
	 * @param dest - The `Sec-Fetch-Dest` the request carried
	 */
	function crossSite(origin: string | null = null, dest: string | null = null) {
		return { reason: 'cross-site', origin, dest };
	}

	const IN_TAB = {
		'Sec-Fetch-Site': 'cross-site',
		'Sec-Fetch-Mode': 'navigate',
		'Sec-Fetch-Dest': 'document',
	};

	test('a request without the fetch metadata headers passes', () => {
		expect(blockReason(request({}), GUARD)).toBeNull();
	});

	test('a host that is not allowed is refused before anything else', () => {
		expect(
			blockReason(
				{
					hostname: 'evil.example',
					pathname: '/',
					method: 'GET',
					headers: new Headers(),
				},
				GUARD,
			),
		).toEqual({ reason: 'host', hostname: 'evil.example' });
	});

	test.each(['same-origin', 'same-site', 'none', 'some-future-value'])(
		'Sec-Fetch-Site: %s passes',
		(site) => {
			expect(
				blockReason(
					request({ 'Sec-Fetch-Site': site, 'Sec-Fetch-Mode': 'no-cors' }),
					GUARD,
				),
			).toBeNull();
		},
	);

	test.each([
		['a script', 'no-cors', 'script', 'GET'],
		['a fetch', 'cors', 'empty', 'GET'],
		['an iframe', 'navigate', 'iframe', 'GET'],
		['a frame', 'navigate', 'frame', 'GET'],
		['an embed', 'navigate', 'embed', 'GET'],
		['an object', 'navigate', 'object', 'GET'],
		['a form', 'navigate', 'document', 'POST'],
	])('a cross-site request for %s is refused', (_, mode, dest, method) => {
		expect(
			blockReason(
				request(
					{
						'Sec-Fetch-Site': 'cross-site',
						'Sec-Fetch-Mode': mode,
						'Sec-Fetch-Dest': dest,
					},
					method,
				),
				GUARD,
			),
		).toEqual(crossSite(null, dest));
	});

	test('a cross-site navigation without a destination is refused', () => {
		expect(
			blockReason(
				request({ 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' }),
				GUARD,
			),
		).toEqual(crossSite());
	});

	test.each(['GET', 'get'])(
		'a cross-site %s that opens a page in a tab passes',
		(method) => {
			expect(blockReason(request(IN_TAB, method), GUARD)).toBeNull();
		},
	);

	test('a cross-site HEAD is not a navigation', () => {
		expect(blockReason(request(IN_TAB, 'HEAD'), GUARD)).toEqual(
			crossSite(null, 'document'),
		);
	});

	test('a cross-site navigation to a proxied path is refused', () => {
		const guard = prepareGuard({
			host: 'localhost',
			allowedHosts: [],
			proxy: { '/api': 'x' },
		});
		expect(blockReason(request(IN_TAB, 'GET', '/api/admin/reset'), guard)).toEqual(
			crossSite(null, 'document'),
		);
		expect(blockReason(request(IN_TAB, 'GET', '/api'), guard)).toEqual(
			crossSite(null, 'document'),
		);
		expect(blockReason(request(IN_TAB, 'GET', '/api-docs'), guard)).toBeNull();
		expect(blockReason(request(IN_TAB, 'GET', '/'), guard)).toBeNull();
	});

	test('a proxy prefix with a trailing slash covers what is under it', () => {
		const guard = prepareGuard({
			host: 'localhost',
			allowedHosts: [],
			proxy: { '/api/': 'x' },
		});
		expect(blockReason(request(IN_TAB, 'GET', '/api/x'), guard)).toEqual(
			crossSite(null, 'document'),
		);
		expect(blockReason(request(IN_TAB, 'GET', '/api'), guard)).toEqual(
			crossSite(null, 'document'),
		);
	});

	// Opened by a LAN address over plain http, the site's own pages send no
	// fetch metadata and an `Origin` that is neither the loopback nor configured.
	test('a request whose Origin is its own host passes', () => {
		const guard = prepareGuard({ host: '0.0.0.0', allowedHosts: [], proxy: {} });
		const own = {
			hostname: '192.168.1.5',
			pathname: '/api/x',
			method: 'POST',
			headers: new Headers({ Origin: 'http://192.168.1.5:3000' }),
		};
		expect(blockReason(own, guard)).toBeNull();
		expect(
			blockReason(
				{ ...own, headers: new Headers({ Origin: 'http://192.168.1.5:8080' }) },
				guard,
			),
		).toBeNull();
		expect(
			blockReason(
				{ ...own, headers: new Headers({ Origin: 'http://192.168.1.6:3000' }) },
				guard,
			),
		).toEqual(crossSite('http://192.168.1.6:3000'));
	});

	test('a navigation to a proxied path from a tool of this machine passes', () => {
		const guard = prepareGuard({
			host: 'localhost',
			allowedHosts: [],
			proxy: { '/api': 'x' },
		});
		expect(
			blockReason(
				request({ ...IN_TAB, Origin: 'http://127.0.0.1:5173' }, 'GET', '/api/x'),
				guard,
			),
		).toBeNull();
	});

	// A browser counts `127.0.0.1` and `localhost` as two sites.
	describe('a cross-site fetch or form with an Origin', () => {
		const guard = prepareGuard({
			host: 'localhost',
			allowedHosts: ['.example.test', '10.0.0.5'],
			proxy: {},
		});

		test.each([
			'http://127.0.0.1:5173',
			'http://[::1]:5173',
			'http://[::ffff:127.0.0.1]:5173',
			'http://localhost:5173',
			'http://app.localhost',
			'https://tool.example.test',
			'http://10.0.0.5:6006',
		])('Origin: %s passes', (origin) => {
			const headers = {
				'Sec-Fetch-Site': 'cross-site',
				'Sec-Fetch-Mode': 'cors',
				Origin: origin,
			};
			expect(blockReason(request(headers), guard)).toBeNull();
			expect(
				blockReason(request({ ...IN_TAB, Origin: origin }, 'POST'), guard),
			).toBeNull();
		});

		test.each([
			'http://203.0.113.5',
			'http://10.0.0.6:5173',
			'https://evil.example',
			'null',
			'not a url',
		])('Origin: %s is refused', (origin) => {
			const headers = {
				'Sec-Fetch-Site': 'cross-site',
				'Sec-Fetch-Mode': 'cors',
				Origin: origin,
			};
			expect(blockReason(request(headers), guard)).toEqual(crossSite(origin));
			expect(blockReason(request({ ...IN_TAB, Origin: origin }, 'POST'), guard)).toEqual(
				crossSite(origin, 'document'),
			);
		});
	});

	test('an Origin that is the address the server listens on passes', () => {
		const headers = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors' };
		const v4 = prepareGuard({ host: '10.0.0.5', allowedHosts: [], proxy: {} });
		expect(
			blockReason(request({ ...headers, Origin: 'http://10.0.0.5:5173' }), v4),
		).toBeNull();
		expect(
			blockReason(request({ ...headers, Origin: 'http://10.0.0.6:5173' }), v4),
		).toEqual(crossSite('http://10.0.0.6:5173'));
		// The config writes an IPv6 address without brackets and in any of its
		// spellings; the URL has brackets and the canonical form.
		const v6 = prepareGuard({ host: 'fe80:0::1', allowedHosts: [], proxy: {} });
		expect(
			blockReason(request({ ...headers, Origin: 'http://[fe80::1]:5173' }), v6),
		).toBeNull();
		const listed = prepareGuard({
			host: 'localhost',
			allowedHosts: ['[0:0:0:0:0:0:0:1]'],
			proxy: {},
		});
		expect(
			blockReason(request({ ...headers, Origin: 'http://[::1]:5173' }), listed),
		).toBeNull();
	});

	describe('without Sec-Fetch-Site', () => {
		const guard = prepareGuard({
			host: 'localhost',
			allowedHosts: ['.example.test'],
			proxy: {},
		});

		test.each([
			'http://localhost:5173',
			'http://127.0.0.1:5173',
			'https://tool.example.test',
		])('Origin: %s passes', (origin) => {
			expect(blockReason(request({ Origin: origin }, 'POST'), guard)).toBeNull();
		});

		test.each(['http://203.0.113.5', 'https://evil.example', 'null'])(
			'Origin: %s is refused',
			(origin) => {
				expect(blockReason(request({ Origin: origin }, 'POST'), guard)).toEqual(
					crossSite(origin),
				);
			},
		);
	});

	test('Sec-Fetch-Site decides when both headers are present', () => {
		expect(
			blockReason(
				request({ 'Sec-Fetch-Site': 'same-site', Origin: 'https://evil.example' }),
				GUARD,
			),
		).toBeNull();
	});
});

describe('setGuard', () => {
	/**
	 * An app whose only route answers `ok`, with the guard in front of it.
	 * @param allowedHosts - `devServer.allowedHosts`
	 */
	function setup(allowedHosts: readonly string[] = []) {
		const app = new Hono();
		const blocked = vi.fn();
		setGuard(app, { host: 'localhost', allowedHosts, proxy: { '/api': 'x' } }, blocked);
		const route = vi.fn(() => new Response('ok'));
		app.all('*', route);
		return { app, blocked, route };
	}

	const HOST_MESSAGE =
		'The host "evil.example" is not allowed. ' +
		'Add it to devServer.allowedHosts to serve it (devServer.host is only the address to listen on).';

	test('a request to an allowed host reaches the route', async () => {
		const { app, blocked, route } = setup();

		const response = await app.request('http://localhost:3000/a?b=1');

		expect(response.status).toBe(200);
		expect(route).toHaveBeenCalledOnce();
		expect(blocked).not.toHaveBeenCalled();
	});

	test('a request to another host is a 403 that names allowedHosts', async () => {
		const { app, blocked, route } = setup();

		const response = await app.request('http://evil.example:3000/a?b=1');

		expect(response.status).toBe(403);
		expect(await response.text()).toBe(HOST_MESSAGE);
		expect(route).not.toHaveBeenCalled();
		expect(blocked).toHaveBeenCalledExactlyOnceWith({
			pathname: '/a',
			status: 403,
			kind: 'blocked',
			ms: expect.any(Number),
			error: HOST_MESSAGE,
		});
	});

	test('a host in allowedHosts reaches the route', async () => {
		const { app, route } = setup(['evil.example']);

		const response = await app.request('http://evil.example:3000/');

		expect(response.status).toBe(200);
		expect(route).toHaveBeenCalledOnce();
	});

	test('a cross-site request is a 403 that says what was refused', async () => {
		const { app, blocked, route } = setup();
		const headers = {
			'Sec-Fetch-Site': 'cross-site',
			'Sec-Fetch-Mode': 'cors',
			'Sec-Fetch-Dest': 'empty',
			Origin: 'https://evil.example',
		};

		const get = await app.request('http://localhost:3000/api/x', { headers });
		const post = await app.request('http://localhost:3000/api/x', {
			method: 'POST',
			headers,
			body: 'x',
		});

		expect(get.status).toBe(403);
		expect(post.status).toBe(403);
		expect(await post.text()).toBe(
			'Cross-site requests to the dev server are not allowed ' +
				'(Origin: https://evil.example, Sec-Fetch-Dest: empty). ' +
				'Open the URL from the address bar, or, when the request is from a tool of yours, ' +
				'add the host of its Origin to devServer.allowedHosts.',
		);
		expect(route).not.toHaveBeenCalled();
		expect(blocked).toHaveBeenCalledTimes(2);
	});

	test('a link from another site opens a page but not a proxied path', async () => {
		const { app, route } = setup();
		const headers = {
			'Sec-Fetch-Site': 'cross-site',
			'Sec-Fetch-Mode': 'navigate',
			'Sec-Fetch-Dest': 'document',
		};

		const page = await app.request('http://localhost:3000/about/', { headers });
		const api = await app.request('http://localhost:3000/api/reset?confirm=1', {
			headers,
		});

		expect(page.status).toBe(200);
		expect(api.status).toBe(403);
		expect(await api.text()).toContain('(Origin: none, Sec-Fetch-Dest: document)');
		expect(route).toHaveBeenCalledOnce();
	});

	// Hono routes on the percent-decoded path: `/%61pi/x` is `/api/x` to the
	// proxy route, so it must be to the guard.
	test('a cross-site navigation to a percent-encoded proxied path is refused', async () => {
		const { app, route } = setup();

		const response = await app.request('http://localhost:3000/%61pi/x', {
			headers: {
				'Sec-Fetch-Site': 'cross-site',
				'Sec-Fetch-Mode': 'navigate',
				'Sec-Fetch-Dest': 'document',
			},
		});

		expect(response.status).toBe(403);
		expect(route).not.toHaveBeenCalled();
	});

	test('without a log callback a refusal is still a 403', async () => {
		const app = new Hono();
		setGuard(app, { host: 'localhost', allowedHosts: [], proxy: {} });

		const response = await app.request('http://evil.example/');

		expect(response.status).toBe(403);
	});

	// `@hono/node-server` builds the URL the guard reads from the `Host`
	// header, which `app.request` does not go through: this goes over real HTTP.
	test('over HTTP the Host header is what is checked', async () => {
		const { app } = setup(['laptop.local']);
		const server = createAdaptorServer({ fetch: app.fetch }) as Server;
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', resolve);
		});
		/**
		 * The status of a GET of `/` with the given `Host`.
		 * @param host - The `Host` header
		 */
		const statusWithHost = (host: string) =>
			new Promise<number>((resolve, reject) => {
				const { port } = server.address() as AddressInfo;
				http
					.get({ host: '127.0.0.1', port, path: '/', headers: { Host: host } }, (res) => {
						res.resume();
						resolve(res.statusCode ?? 0);
					})
					.on('error', reject);
			});
		try {
			expect(await statusWithHost('127.0.0.1:3000')).toBe(200);
			expect(await statusWithHost('[::1]:3000')).toBe(200);
			expect(await statusWithHost('laptop.local')).toBe(200);
			expect(await statusWithHost('evil.example')).toBe(403);
			expect(await statusWithHost('localhost.evil.example:3000')).toBe(403);
		} finally {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		}
	});
});
