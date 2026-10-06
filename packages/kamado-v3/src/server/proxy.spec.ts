import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';

import { hasBody, normalizeRule, rewritePath, setProxyRoutes } from './proxy.js';

describe('normalizeRule', () => {
	test('a string is a target', () => {
		expect(normalizeRule('http://localhost:8080')).toEqual({
			target: 'http://localhost:8080',
		});
	});

	test('a rule stays as it is', () => {
		const rule = { target: 'http://localhost:8080', changeOrigin: true };
		expect(normalizeRule(rule)).toBe(rule);
	});
});

describe('rewritePath', () => {
	test('applies the regular expression and its replacement', () => {
		expect(rewritePath('/api/users/1', { from: '^/api', to: '' })).toBe('/users/1');
		expect(rewritePath('/api/users', { from: '^/api/(\\w+)', to: '/v2/$1' })).toBe(
			'/v2/users',
		);
	});

	test('without a rewrite the path is unchanged', () => {
		expect(rewritePath('/api/users')).toBe('/api/users');
	});
});

describe('hasBody', () => {
	test.each([
		['GET', false],
		['head', false],
		['POST', true],
		['put', true],
		['DELETE', true],
	])('%s: %s', (method, expected) => {
		expect(hasBody(method)).toBe(expected);
	});
});

/**
 * An app with the proxy routes and a fake `fetch` that records its calls.
 * @param proxy - Rules by prefix
 * @param respond - What the fake server answers
 */
function setup(
	proxy: Parameters<typeof setProxyRoutes>[1],
	respond: () => Response | Promise<Response> = () =>
		new Response('from target', { status: 200 }),
) {
	const calls: { url: string; init: RequestInit }[] = [];
	const fakeFetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init: init ?? {} });
		return Promise.resolve(respond());
	});
	const app = new Hono();
	setProxyRoutes(app, proxy, fakeFetch as unknown as typeof fetch);
	return { app, calls };
}

describe('setProxyRoutes', () => {
	test('forwards the prefix and everything under it with the query', async () => {
		const { app, calls } = setup({ '/api': 'http://backend.test:8080' });

		const response = await app.request('/api/users?page=2');

		expect(await response.text()).toBe('from target');
		expect(calls.map((c) => c.url)).toEqual([
			'http://backend.test:8080/api/users?page=2',
		]);
	});

	test('the prefix itself is forwarded too, and other paths are not', async () => {
		const { app, calls } = setup({ '/api': 'http://backend.test' });

		await app.request('/api');
		const other = await app.request('/apiary');

		expect(calls.map((c) => c.url)).toEqual(['http://backend.test/api']);
		expect(other.status).toBe(404);
	});

	test('rewrites the path with the regular expression', async () => {
		const { app, calls } = setup({
			'/api': { target: 'http://backend.test/', rewrite: { from: '^/api', to: '/v1' } },
		});

		await app.request('/api/users');

		expect(calls[0]!.url).toBe('http://backend.test/v1/users');
	});

	test('a rewrite that makes the path a network-path reference is refused', async () => {
		const { app, calls } = setup({
			'/api': { target: 'http://backend.test', rewrite: { from: '^/api', to: '' } },
		});

		const response = await app.request('/api//evil.example/x');

		expect(response.status).toBe(400);
		expect(calls).toEqual([]);
	});

	test('changeOrigin sends the host and origin of the target', async () => {
		const { app, calls } = setup({
			'/api': { target: 'https://backend.test:9000', changeOrigin: true },
		});

		await app.request('http://localhost:3000/api/x', {
			headers: { host: 'localhost:3000' },
		});

		const headers = new Headers(calls[0]!.init.headers);
		expect(headers.get('host')).toBe('backend.test:9000');
		expect(headers.get('origin')).toBe('https://backend.test:9000');
	});

	test('the longest prefix wins and redirects are left to the browser', async () => {
		const { app, calls } = setup({
			'/api': 'http://short.test',
			'/api/v2': 'http://long.test',
		});

		await app.request('/api/v2/items');

		expect(calls[0]!.url).toBe('http://long.test/api/v2/items');
		expect(calls[0]!.init.redirect).toBe('manual');
	});

	test('the status and headers of the target come back as they are', async () => {
		const { app } = setup({ '/api': 'http://backend.test' }, () =>
			Response.redirect('http://elsewhere.test/', 302),
		);

		const response = await app.request('/api/old');

		expect(response.status).toBe(302);
		expect(response.headers.get('location')).toBe('http://elsewhere.test/');
	});

	test('a request body is streamed to the target', async () => {
		const { app, calls } = setup({ '/api': 'http://backend.test' });

		await app.request('/api/users', { method: 'POST', body: 'name=a' });

		expect(calls[0]!.init.method).toBe('POST');
		expect(calls[0]!.init.body).toBeDefined();
	});

	test('a network error is a 502', async () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { app } = setup({ '/api': 'http://backend.test' }, () => {
			throw new Error('connect ECONNREFUSED');
		});

		const response = await app.request('/api/x');

		expect(response.status).toBe(502);
		expect(await response.text()).toBe('Proxy error');
		expect(String(spy.mock.calls[0]![0])).toContain('connect ECONNREFUSED');
		spy.mockRestore();
	});

	test('an invalid target or rewrite fails at setup and names the prefix', () => {
		expect(() => setup({ '/api': 'not a url' })).toThrow(/^devServer\.proxy\.\/api: /);
		expect(() =>
			setup({
				'/api': { target: 'http://backend.test', rewrite: { from: '(', to: '' } },
			}),
		).toThrow(/^devServer\.proxy\.\/api: /);
	});
});
