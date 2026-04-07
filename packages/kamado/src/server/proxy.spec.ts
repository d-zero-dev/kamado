import { Hono } from 'hono';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

import { hasBody, normalizeRule, setProxyRoutes } from './proxy.js';

describe('normalizeRule', () => {
	test('converts string to ProxyRule object', () => {
		expect(normalizeRule('https://example.com')).toEqual({
			target: 'https://example.com',
		});
	});

	test('returns ProxyRule object as-is', () => {
		const rule = { target: 'https://example.com', changeOrigin: true };
		expect(normalizeRule(rule)).toBe(rule);
	});
});

describe('hasBody', () => {
	test.each([
		['GET', false],
		['HEAD', false],
		['POST', true],
		['PUT', true],
		['PATCH', true],
		['DELETE', true],
	])('%s → %s', (method, expected) => {
		expect(hasBody(method)).toBe(expected);
	});
});

describe('setProxyRoutes', () => {
	beforeEach(() => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(new Response('upstream', { status: 200 })),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test('fetches to the target specified by string shorthand', async () => {
		const app = new Hono();
		setProxyRoutes(app, { '/api': 'https://backend.example.com' });

		await app.request('/api/users');

		const fetchMock = vi.mocked(fetch);
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock.mock.calls[0]![0]).toBe('https://backend.example.com/api/users');
	});

	test('longer path prefix matches first (/api/v2 takes priority over /api)', async () => {
		const app = new Hono();
		setProxyRoutes(app, {
			'/api': 'https://v1.example.com',
			'/api/v2': 'https://v2.example.com',
		});

		await app.request('/api/v2/users');

		expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
		expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(
			'https://v2.example.com/api/v2/users',
		);
	});

	test('fetches to the URL with pathRewrite applied', async () => {
		const app = new Hono();
		setProxyRoutes(app, {
			'/api': {
				target: 'https://backend.example.com',
				pathRewrite: (p) => p.replace(/^\/api/, ''),
			},
		});

		await app.request('/api/users');

		expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('https://backend.example.com/users');
	});

	test('rewrites Host/Origin headers to target when changeOrigin is true', async () => {
		const app = new Hono();
		setProxyRoutes(app, {
			'/api': { target: 'https://backend.example.com', changeOrigin: true },
		});

		await app.request('/api/data');

		const [, init] = vi.mocked(fetch).mock.calls[0]! as [string, RequestInit];
		const headers = init.headers as Headers;
		expect(headers.get('host')).toBe('backend.example.com');
		expect(headers.get('origin')).toBe('https://backend.example.com');
	});

	test('does not rewrite Host header when changeOrigin is false (default)', async () => {
		const app = new Hono();
		setProxyRoutes(app, {
			'/api': { target: 'https://backend.example.com' },
		});

		await app.request('/api/data');

		const [, init] = vi.mocked(fetch).mock.calls[0]! as [string, RequestInit];
		const headers = init.headers as Headers;
		expect(headers.get('host')).not.toBe('backend.example.com');
		expect(headers.get('origin')).toBeNull();
	});

	test('returns 502 when fetch fails', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
		const app = new Hono();
		setProxyRoutes(app, { '/api': 'https://backend.example.com' });

		const res = await app.request('/api/data');

		expect(res.status).toBe(502);
	});

	test('does not pass body to fetch for GET requests', async () => {
		const app = new Hono();
		setProxyRoutes(app, { '/api': 'https://backend.example.com' });

		await app.request('/api/data', { method: 'GET' });

		const [, init] = vi.mocked(fetch).mock.calls[0]! as [string, RequestInit];
		expect(init.body).toBeUndefined();
	});

	test('does not pass body to fetch for HEAD requests', async () => {
		const app = new Hono();
		setProxyRoutes(app, { '/api': 'https://backend.example.com' });

		await app.request('/api/data', { method: 'HEAD' });

		const [, init] = vi.mocked(fetch).mock.calls[0]! as [string, RequestInit];
		expect(init.body).toBeUndefined();
	});

	test('passes body to fetch for POST requests', async () => {
		const app = new Hono();
		setProxyRoutes(app, { '/api': 'https://backend.example.com' });

		const body = JSON.stringify({ name: 'test' });
		await app.request('/api/data', {
			method: 'POST',
			body,
			headers: { 'Content-Type': 'application/json' },
		});

		const [, init] = vi.mocked(fetch).mock.calls[0]! as [string, RequestInit];
		expect(init.method).toBe('POST');
		expect(init.body).toBeDefined();
	});

	test('preserves query strings when forwarding to target', async () => {
		const app = new Hono();
		setProxyRoutes(app, { '/api': 'https://backend.example.com' });

		await app.request('/api/users?page=2&limit=10');

		expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(
			'https://backend.example.com/api/users?page=2&limit=10',
		);
	});

	test('matches the prefix path exactly without trailing slash', async () => {
		const app = new Hono();
		setProxyRoutes(app, { '/api': 'https://backend.example.com' });

		await app.request('/api');

		expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
		expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('https://backend.example.com/api');
	});
});
