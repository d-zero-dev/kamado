import { beforeEach, describe, expect, test, vi } from 'vitest';

const prepare =
	vi.fn<(configPath: string, optionsJson: string, runtimeUrl: string) => string>();
const finish = vi.fn<(handle: string, renderedJson: string) => string>();
const abort = vi.fn<(handle: string) => void>();

vi.mock('./native.js', () => ({
	native: () => ({ prepare, finish, abort }),
}));

const { build } = await import('./build.js');

const REPORT = JSON.stringify({
	version: 1,
	pages: [
		{
			url: '/',
			inputPath: '/s/index.html',
			outputPath: '/o/index.html',
			status: 'built',
			meta: { title: 'Home' },
		},
	],
	warnings: [],
	elapsedMs: 3,
});

const NOTHING_TO_RENDER = JSON.stringify({ handle: '7', jobs: [], context: null });

describe('build', () => {
	beforeEach(() => {
		prepare.mockReset();
		finish.mockReset();
		abort.mockReset();
		prepare.mockReturnValue(NOTHING_TO_RENDER);
		finish.mockReturnValue(REPORT);
	});

	test('passes the config path, the options as JSON and the runtime to the core', async () => {
		await build('/site/kamado.config.jsonc', {
			incremental: true,
			force: false,
			targets: ['sub/**'],
			jobs: 4,
			cacheDir: '/cache',
		});

		expect(prepare).toHaveBeenCalledExactlyOnceWith(
			'/site/kamado.config.jsonc',
			'{"incremental":true,"force":false,"targets":["sub/**"],"jobs":4,"cacheDir":"/cache"}',
			expect.stringMatching(/^file:\/\/.*\/jsx\/runtime\.js$/),
		);
	});

	test('without options the core receives an empty object', async () => {
		await build('/site/kamado.config.jsonc');

		expect(prepare).toHaveBeenCalledExactlyOnceWith(
			'/site/kamado.config.jsonc',
			'{}',
			expect.any(String),
		);
	});

	test('a site with nothing to render finishes with no rendered pages', async () => {
		await build('/site/kamado.config.jsonc');

		expect(finish).toHaveBeenCalledExactlyOnceWith('7', '[]');
		expect(abort).not.toHaveBeenCalled();
	});

	test('returns the report the core produced, parsed', async () => {
		expect(await build('/site/kamado.config.jsonc')).toEqual({
			version: 1,
			pages: [
				{
					url: '/',
					inputPath: '/s/index.html',
					outputPath: '/o/index.html',
					status: 'built',
					meta: { title: 'Home' },
				},
			],
			warnings: [],
			elapsedMs: 3,
		});
	});

	test('errors thrown while planning reach the caller unchanged', async () => {
		prepare.mockImplementation(() => {
			throw new Error('/site/kamado.config.jsonc: pages.file: unknown option');
		});

		await expect(build('/site/kamado.config.jsonc')).rejects.toThrow(
			'/site/kamado.config.jsonc: pages.file: unknown option',
		);
	});

	test('a failure while finishing releases the prepared build', async () => {
		finish.mockImplementation(() => {
			throw new Error('cannot write /o/index.html');
		});

		await expect(build('/site/kamado.config.jsonc')).rejects.toThrow(
			'cannot write /o/index.html',
		);
		expect(abort).toHaveBeenCalledExactlyOnceWith('7');
	});
});
