import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const prepare =
	vi.fn<(configPath: string, optionsJson: string, runtimeUrl: string) => string>();
const finish = vi.fn<(handle: string, resultsJson: string) => string>();
const abort = vi.fn<(handle: string) => void>();
const feed = vi.fn<(handle: string, frames: Buffer) => void>();
const renderJobs =
	vi.fn<
		(
			jobs: unknown,
			context: unknown,
			options: { onRendered: (rendered: [number, string][]) => void },
		) => Promise<unknown[]>
	>();
const buildScripts = vi.fn<(request: unknown) => Promise<unknown[]>>();

vi.mock('./native.js', () => ({
	native: () => ({ prepare, finish, abort, feed }),
}));
vi.mock('./render.js', () => ({
	renderJobs: (
		jobs: unknown,
		context: unknown,
		options: { onRendered: (rendered: [number, string][]) => void },
	) => renderJobs(jobs, context, options),
}));
vi.mock('./scripts.js', () => ({
	ESBUILD_VERSION: '0.0.1-test',
	findEsbuildBinary: () => '/fake/esbuild',
	buildScripts: (request: unknown) => buildScripts(request),
}));

const { build } = await import('./build.js');
const { buildFrom } = await import('./build-from.js');
const { resolveTargets } = await import('./targets.js');

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
		feed.mockReset();
		renderJobs.mockReset();
		buildScripts.mockReset();
		prepare.mockReturnValue(NOTHING_TO_RENDER);
		finish.mockReturnValue(REPORT);
	});

	test('refuses an unknown option before the core is called', async () => {
		await expect(
			build('/site/kamado.config.jsonc', {
				incrementl: true,
			} as never),
		).rejects.toThrow('unknown option: incrementl');
		expect(prepare).not.toHaveBeenCalled();
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
			// Behavior change: relative targets are resolved from the directory of the config file
			targets: ['/site/sub/**'],
			// targets: ['sub/**'], // previous
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
			tzOffsetMinutes: 0 - new Date().getTimezoneOffset(),
			esbuildVersion: '0.0.1-test',
			esbuildBinary: '/fake/esbuild',
		});
	});

	test('a site with nothing to render finishes with no rendered pages or scripts', async () => {
		await build('/site/kamado.config.jsonc');

		expect(finish).toHaveBeenCalledExactlyOnceWith('7', '{"scripts":[]}');
		expect(feed).not.toHaveBeenCalled();
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
			'{"scripts":[{"id":0,"code":"console.log(1);\\n","inputs":["/site/src/a.ts"]}]}',
		);
	});

	test('the HTML goes to the core as each batch is rendered, framed with its page and length', async () => {
		prepare.mockReturnValue(
			JSON.stringify({
				handle: '7',
				jobs: [{ page: 3, main: '/m.mjs', layout: null, content: null }],
				context: { pages: [] },
				scripts: null,
			}),
		);
		renderJobs.mockImplementation((_jobs, _context, options) => {
			options.onRendered([
				[3, '<p>é</p>'],
				[258, ''],
			]);
			return Promise.resolve([]);
		});

		await build('/site/kamado.config.jsonc');

		expect(feed).toHaveBeenCalledExactlyOnceWith('7', expect.any(Buffer));
		const frames = feed.mock.calls[0]![1];
		// Page 3, nine bytes ("é" is two), the text; then page 258 and nothing.
		expect([...frames]).toEqual([
			3,
			0,
			0,
			0,
			9,
			0,
			0,
			0,
			...Buffer.from('<p>é</p>'),
			2,
			1,
			0,
			0,
			0,
			0,
			0,
			0,
		]);
		expect(finish).toHaveBeenCalledExactlyOnceWith('7', '{"scripts":[]}');
	});

	test('progress is reported as pages are rendered and is not given to the core', async () => {
		prepare.mockReturnValue(
			JSON.stringify({
				handle: '7',
				jobs: [
					{ page: 0, main: '/m.mjs', layout: null, content: null },
					{ page: 1, main: '/m.mjs', layout: null, content: null },
					{ page: 2, main: '/m.mjs', layout: null, content: null },
				],
				context: { pages: [] },
				scripts: null,
			}),
		);
		renderJobs.mockImplementation((_jobs, _context, options) => {
			options.onRendered([[0, 'a']]);
			options.onRendered([
				[1, 'b'],
				[2, 'c'],
			]);
			return Promise.resolve([]);
		});
		const progress: [number, number][] = [];

		await build('/site/kamado.config.jsonc', {
			onProgress: (done, total) => progress.push([done, total]),
		});

		expect(progress).toEqual([
			[1, 3],
			[3, 3],
		]);
		expect(JSON.parse(prepare.mock.calls[0]![1])).not.toHaveProperty('onProgress');
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

describe('resolveTargets', () => {
	let root = '';
	let site = '';
	let odd = '';
	let extglob = '';

	beforeAll(() => {
		root = mkdtempSync(path.join(tmpdir(), 'kamado-targets-'));
		site = path.join(root, 'site');
		mkdirSync(path.join(site, 'css'), { recursive: true });
		writeFileSync(path.join(site, 'css', 'style.css'), '');
		odd = path.join(root, 'a[1]{2}');
		mkdirSync(odd, { recursive: true });
		writeFileSync(path.join(odd, 'p.html'), '');
		extglob = path.join(root, 'site (copy)|+@!');
		mkdirSync(extglob, { recursive: true });
		writeFileSync(path.join(extglob, 'p.html'), '');
	});

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test('a path without glob characters is a file of the base directory, written as an exact pattern', () => {
		expect(resolveTargets(['css/style.css'], site)).toEqual([`${site}/css/style.css`]);
		expect(resolveTargets(['./css/../css/style.css'], site)).toEqual([
			`${site}/css/style.css`,
		]);
		expect(resolveTargets(['../css/style.css'], path.join(site, 'css'))).toEqual([
			`${site}/css/style.css`,
		]);
	});

	test('a glob is put under the base directory, and an absolute one is kept', () => {
		expect(resolveTargets(['css/*.css', '**/*.html'], site)).toEqual([
			`${site}/css/*.css`,
			`${site}/**/*.html`,
		]);
		expect(resolveTargets(['../css/*.css'], path.join(site, 'css'))).toEqual([
			`${site}/css/*.css`,
		]);
		expect(
			resolveTargets([`${site}/css/*.css`, `${site}/css/style.css`], '/elsewhere'),
		).toEqual([`${site}/css/*.css`, `${site}/css/style.css`]);
	});

	test('a path without glob characters that does not exist is an error', () => {
		expect(() => resolveTargets(['css/nope.css'], site)).toThrow(
			`target not found: css/nope.css (${site}/css/nope.css)`,
		);
	});

	test('the glob characters of the base directory are escaped', () => {
		const escaped = `${root}/a\\[1\\]\\{2\\}`;
		expect(resolveTargets(['p.html', '*.html'], odd)).toEqual([
			`${escaped}/p.html`,
			`${escaped}/*.html`,
		]);
	});

	test('the characters the glob refuses as extglob syntax are escaped in the base directory too', () => {
		const escaped = `${root}/site \\(copy\\)\\|\\+\\@\\!`;
		expect(resolveTargets(['p.html', '*.html'], extglob)).toEqual([
			`${escaped}/p.html`,
			`${escaped}/*.html`,
		]);
	});

	test('a directory stands for every file under it', () => {
		expect(resolveTargets(['css', `${site}/css`], site)).toEqual([
			`${site}/css/**`,
			`${site}/css/**`,
		]);
	});

	test('a negated glob is an error, as the core refuses it', () => {
		expect(() => resolveTargets(['!css/*.css'], site)).toThrow(
			'negated glob "!css/*.css" is not supported',
		);
	});

	test('an absolute glob is normalized, and an absolute path that does not exist is an error', () => {
		expect(resolveTargets([`${site}/css/../css/*.css`], '/elsewhere')).toEqual([
			`${site}/css/*.css`,
		]);
		expect(() => resolveTargets([`${site}/nope.css`], '/elsewhere')).toThrow(
			`target not found: ${site}/nope.css (${site}/nope.css)`,
		);
	});

	test('a path and a base directory that go through a symbolic link keep the link, as the input files do', () => {
		const link = path.join(root, 'link');
		symlinkSync(site, link);

		expect(resolveTargets(['link/css/style.css'], root)).toEqual([
			`${link}/css/style.css`,
		]);
		expect(resolveTargets(['css/*.css'], link)).toEqual([`${link}/css/*.css`]);
	});

	test('an empty entry is an error, not the whole base directory', () => {
		expect(() => resolveTargets([''], site)).toThrow('an empty target is not supported');
	});

	test('the dot segments after the first glob segment are kept as written', () => {
		expect(resolveTargets(['./css/*/../x.css'], site)).toEqual([
			`${site}/css/*/../x.css`,
		]);
		expect(resolveTargets(['../site/*.html'], odd)).toEqual([`${root}/site/*.html`]);
	});
});

describe('the base directory of targets', () => {
	beforeEach(() => {
		prepare.mockReset();
		finish.mockReset();
		prepare.mockReturnValue(NOTHING_TO_RENDER);
		finish.mockReturnValue(REPORT);
	});

	test('build resolves them from the directory of the config file', async () => {
		await build('/site/kamado.config.jsonc', { targets: ['css/*.css'] });

		expect(JSON.parse(prepare.mock.calls[0]![1]).targets).toEqual(['/site/css/*.css']);
	});

	test('buildFrom resolves them from the directory it is given, as the CLI gives the cwd', async () => {
		await buildFrom(
			'/site/kamado.config.jsonc',
			{ targets: ['__assets/*.css'] },
			'/work',
		);

		expect(JSON.parse(prepare.mock.calls[0]![1]).targets).toEqual([
			'/work/__assets/*.css',
		]);
	});

	test('no targets give the core no targets, and an empty list stays empty', async () => {
		await build('/site/kamado.config.jsonc', {});
		await build('/site/kamado.config.jsonc', { targets: [] });

		expect(JSON.parse(prepare.mock.calls[0]![1])).not.toHaveProperty('targets');
		expect(JSON.parse(prepare.mock.calls[1]![1]).targets).toEqual([]);
	});
});
