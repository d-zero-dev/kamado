import { Hono } from 'hono';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

import { setProxyRoutes } from './proxy.js';

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

		expect(vi.mocked(fetch).mock.calls[0]![0]).toContain('v2.example.com');
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
});
