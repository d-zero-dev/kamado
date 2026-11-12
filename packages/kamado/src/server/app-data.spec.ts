import { beforeEach, describe, expect, test, vi } from 'vitest';

const serveRequest =
	vi.fn<(handle: string, urlPath: string, rendererStarted: '0' | '1') => string>();
const serveSetData = vi.fn<(handle: string, executed: string) => string>();
const serveClose = vi.fn<(handle: string) => void>();

vi.mock('../native.js', () => ({
	native: () => ({ serveRequest, serveSetData, serveClose }),
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
	body: '<p>x</p>',
});

/**
 * A source of data files that says what the test tells it to.
 * @param changes - What each call of `refresh` answers, the last one again and again
 */
function data(...changes: boolean[]) {
	const queue = [...changes];
	return {
		refresh: vi.fn(() => Promise.resolve(queue.length > 1 ? queue.shift()! : queue[0]!)),
		executed: vi.fn(() => ({ news: { value: 1 } })),
	};
}

/**
 * Asks the app for a path.
 * @param source - The data files
 * @param pathname - The path
 */
async function get(source: ReturnType<typeof data> | undefined, pathname: string) {
	const { app } = createApp(DESCRIPTION, 'file:///runtime.js', {
		...(source === undefined ? {} : { data: source }),
	});
	return app.request(`http://localhost:3000${pathname}`, {
		headers: { host: 'localhost:3000' },
	});
}

beforeEach(() => {
	vi.resetAllMocks();
	serveRequest.mockReturnValue(ANSWER);
	serveSetData.mockReturnValue('{}');
});

describe('the data files that are scripts', () => {
	test('the core is given their values before it answers, when they changed', async () => {
		const source = data(true);

		await get(source, '/index.html');

		expect(serveSetData).toHaveBeenCalledWith('h1', '{"news":{"value":1}}');
		expect(serveSetData.mock.invocationCallOrder[0]).toBeLessThan(
			serveRequest.mock.invocationCallOrder[0]!,
		);
	});

	test('the core is not told when nothing changed', async () => {
		await get(data(false), '/index.html');

		expect(serveSetData).not.toHaveBeenCalled();
		expect(serveRequest).toHaveBeenCalled();
	});

	test('a file (a stylesheet, an image) does not wait for the data files', async () => {
		const source = data(true);

		await get(source, '/css/a.css');
		await get(source, '/img/logo.png');

		expect(source.refresh).not.toHaveBeenCalled();
	});

	test.each(['/', '/news/', '/about', '/a.html', '/a.HTM', '/feed.xml', '/data.json'])(
		'%s may be a page, whatever its extension: the data files are looked at',
		async (pathname) => {
			const source = data(false);

			await get(source, pathname);

			expect(source.refresh).toHaveBeenCalledTimes(1);
		},
	);

	test('values that the core refused are given again by the next request', async () => {
		const source = data(true, false);
		serveSetData.mockImplementationOnce(() => {
			throw new Error('two files have the same key');
		});
		const { app } = createApp(DESCRIPTION, 'file:///runtime.js', { data: source });

		const first = await app.request('http://localhost:3000/a.html', {
			headers: { host: 'localhost:3000' },
		});
		const second = await app.request('http://localhost:3000/a.html', {
			headers: { host: 'localhost:3000' },
		});

		expect(first.status).toBe(500);
		expect(second.status).toBe(200);
		expect(serveSetData).toHaveBeenCalledTimes(2);
	});
});
