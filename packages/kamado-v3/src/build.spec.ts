import { beforeEach, describe, expect, test, vi } from 'vitest';

const prepare =
	vi.fn<(configPath: string, optionsJson: string, runtimeUrl: string) => string>();
const finish = vi.fn<(handle: string, resultsJson: string) => string>();
const abort = vi.fn<(handle: string) => void>();
const buildScripts = vi.fn<(request: unknown) => Promise<unknown[]>>();

vi.mock('./native.js', () => ({
	native: () => ({ prepare, finish, abort }),
}));
vi.mock('./scripts.js', () => ({
	ESBUILD_VERSION: '0.0.1-test',
	findEsbuildBinary: () => '/fake/esbuild',
	buildScripts: (request: unknown) => buildScripts(request),
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
	assets: [],
	warnings: [],
	elapsedMs: 3,
});

const NOTHING_TO_RENDER = JSON.stringify({
	handle: '7',
	jobs: [],
	context: null,
	scripts: null,
});

describe('build', () => {
	beforeEach(() => {
		prepare.mockReset();
		finish.mockReset();
		abort.mockReset();
		buildScripts.mockReset();
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
			expect.any(String),
			expect.stringMatching(/^file:\/\/.*\/jsx\/runtime\.js$/),
		);
		expect(JSON.parse(prepare.mock.calls[0]![1])).toEqual({
			incremental: true,
			force: false,
			targets: ['sub/**'],
			jobs: 4,
			cacheDir: '/cache',
			tzOffsetMinutes: expect.any(Number),
			esbuildVersion: '0.0.1-test',
			esbuildBinary: '/fake/esbuild',
		});
	});

	test('tells the core the local time zone and the version of esbuild', async () => {
		await build('/site/kamado.config.jsonc');

		expect(JSON.parse(prepare.mock.calls[0]![1])).toEqual({
			tzOffsetMinutes: -new Date().getTimezoneOffset(),
			esbuildVersion: '0.0.1-test',
			esbuildBinary: '/fake/esbuild',
		});
	});

	test('a site with nothing to render finishes with no rendered pages or scripts', async () => {
		await build('/site/kamado.config.jsonc');

		expect(finish).toHaveBeenCalledExactlyOnceWith('7', '{"pages":[],"scripts":[]}');
		expect(buildScripts).not.toHaveBeenCalled();
		expect(abort).not.toHaveBeenCalled();
	});

	test('the scripts the core asks for are built and handed back', async () => {
		const request = {
			root: '/site',
			options: {},
			entries: [{ id: 0, input: '/site/src/a.ts', output: '/site/out/a.js' }],
		};
		prepare.mockReturnValue(
			JSON.stringify({ handle: '7', jobs: [], context: null, scripts: request }),
		);
		buildScripts.mockResolvedValue([
			{ id: 0, code: 'console.log(1);\n', inputs: ['/site/src/a.ts'] },
		]);

		await build('/site/kamado.config.jsonc');

		expect(buildScripts).toHaveBeenCalledExactlyOnceWith(request);
		expect(finish).toHaveBeenCalledExactlyOnceWith(
			'7',
			'{"pages":[],"scripts":[{"id":0,"code":"console.log(1);\\n","inputs":["/site/src/a.ts"]}]}',
		);
	});

	test('a script that fails to build releases the prepared build', async () => {
		prepare.mockReturnValue(
			JSON.stringify({ handle: '7', jobs: [], context: null, scripts: { entries: [] } }),
		);
		buildScripts.mockRejectedValue(new Error('Could not resolve "./missing"'));

		await expect(build('/site/kamado.config.jsonc')).rejects.toThrow(
			'Could not resolve "./missing"',
		);
		expect(finish).not.toHaveBeenCalled();
		expect(abort).toHaveBeenCalledExactlyOnceWith('7');
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
			assets: [],
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
