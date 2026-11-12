import { beforeEach, describe, expect, test, vi } from 'vitest';

const serveRequest =
	vi.fn<(handle: string, urlPath: string, rendererStarted: '0' | '1') => string>();
const serveFinishRender =
	vi.fn<(handle: string, token: string, html: string) => string>();
const serveFinishRenderReads =
	vi.fn<(handle: string, token: string, html: string, reads: string) => string>();
const serveCancel = vi.fn<(handle: string, token: string) => string>();
const serveClose = vi.fn<(handle: string) => void>();

vi.mock('../native.js', () => ({
	native: () => ({
		serveRequest,
		serveFinishRender,
		serveFinishRenderReads,
		serveCancel,
		serveClose,
	}),
}));

const { createApp } = await import('./app.js');

const DESCRIPTION = {
	handle: 'h1',
	devServer: {
		port: 3000,
		host: 'localhost',
		allowedHosts: [],
		open: false,
		startPath: '/',
		proxy: {},
	},
	inputDir: '/s',
	outputDir: '/o',
};

const ANSWER = JSON.stringify({
	kind: 'text',
	contentType: 'text/html',
	body: '<p>done</p>\n',
});

/**
 * A renderer that answers with fixed HTML and says which keys of `data` the page read.
 * @param reads - What it reports (`undefined`: it does not report)
 */
function renderer(reads: readonly string[] | null | undefined) {
	let started = false;
	return {
		get started() {
			return started;
		},
		start: vi.fn(() => {
			started = true;
		}),
		update: vi.fn(),
		render: vi.fn((_job: unknown, onReads?: (keys: readonly string[] | null) => void) => {
			if (reads !== undefined) {
				onReads?.(reads);
			}
			return Promise.resolve('<p>rendered</p>');
		}),
		close: vi.fn(() => Promise.resolve()),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	serveRequest.mockReturnValue(
		JSON.stringify({
			kind: 'render',
			token: '5',
			job: { page: 3, main: '/m.mjs', layout: null, content: null },
			restart: false,
			context: { pages: [] },
			update: null,
		}),
	);
	serveFinishRender.mockReturnValue(ANSWER);
	serveFinishRenderReads.mockReturnValue(ANSWER);
});

describe('the keys of data a rendered page read', () => {
	test('go to the core with the HTML, so that the page is rendered again only when they change', async () => {
		const { app } = createApp(DESCRIPTION, 'file:///rt.js', {
			renderer: renderer(['posts', 'site']),
		});

		await app.request('/page.html');

		expect(serveFinishRenderReads).toHaveBeenCalledExactlyOnceWith(
			'h1',
			'5',
			'<p>rendered</p>',
			'["posts","site"]',
		);
		expect(serveFinishRender).not.toHaveBeenCalled();
	});

	test('a page that read no key at all is a page of an empty list', async () => {
		const { app } = createApp(DESCRIPTION, 'file:///rt.js', { renderer: renderer([]) });

		await app.request('/page.html');

		expect(serveFinishRenderReads).toHaveBeenCalledWith(
			'h1',
			'5',
			'<p>rendered</p>',
			'[]',
		);
	});

	test('every key (null) and no report both leave the page depending on every key', async () => {
		for (const reads of [null, undefined]) {
			serveFinishRender.mockClear();
			const { app } = createApp(DESCRIPTION, 'file:///rt.js', {
				renderer: renderer(reads),
			});

			await app.request('/page.html');

			expect(serveFinishRender).toHaveBeenCalledExactlyOnceWith(
				'h1',
				'5',
				'<p>rendered</p>',
			);
		}
		expect(serveFinishRenderReads).not.toHaveBeenCalled();
	});
});
