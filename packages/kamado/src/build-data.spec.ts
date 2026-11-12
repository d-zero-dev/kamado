import { beforeEach, describe, expect, test, vi } from 'vitest';

const prepare =
	vi.fn<(configPath: string, optionsJson: string, runtimeUrl: string) => string>();
const finish = vi.fn<(handle: string, resultsJson: string) => string>();
const abort = vi.fn<(handle: string) => void>();
const runAll = vi.fn<() => Promise<void>>();
const executed = vi.fn<() => Record<string, unknown>>();
let verbose: ((line: string) => void) | undefined;

vi.mock('./native.js', () => ({
	native: () => ({ prepare, finish, abort, feed: vi.fn() }),
}));
vi.mock('./data-files.js', () => ({
	readDataPlan: () => ({ cacheDir: '', dataDir: null, extensions: [], modules: [] }),
	DataFiles: class {
		constructor(_plan: unknown, options: { verbose?: (line: string) => void }) {
			verbose = options.verbose;
		}
		executed() {
			return executed();
		}
		runAll() {
			return runAll();
		}
	},
}));
vi.mock('./render.js', () => ({ renderJobs: vi.fn(() => Promise.resolve([])) }));
vi.mock('./scripts.js', () => ({
	ESBUILD_VERSION: '0.0.1-test',
	findEsbuildBinary: () => '/fake/esbuild',
	buildScripts: vi.fn(() => Promise.resolve([])),
}));

const { buildFrom } = await import('./build-from.js');

const REPORT = '{"pages":[],"assets":[],"warnings":[],"elapsedMs":1}';

beforeEach(() => {
	vi.resetAllMocks();
	prepare.mockReturnValue('{"handle":"1","jobs":[],"context":null,"scripts":null}');
	finish.mockReturnValue(REPORT);
	runAll.mockResolvedValue();
	executed.mockReturnValue({});
});

describe('the data files that are scripts, in a build', () => {
	test('a file that fails stops the build before the core plans it', async () => {
		runAll.mockRejectedValue(new Error('data files failed:\n  rates.ts: down'));

		await expect(buildFrom('/s/kamado.config.jsonc', {}, '/s')).rejects.toThrow(
			'rates.ts: down',
		);

		expect(prepare).not.toHaveBeenCalled();
	});

	test('what they made is given to the core, and nothing is given when there are none', async () => {
		await buildFrom('/s/kamado.config.jsonc', {}, '/s');
		executed.mockReturnValue({ rates: { value: { total: 3 } } });
		await buildFrom('/s/kamado.config.jsonc', {}, '/s');

		const [first, second] = prepare.mock.calls.map(
			([, options]) => JSON.parse(options) as Record<string, unknown>,
		);
		expect(first).not.toHaveProperty('executedData');
		expect(second?.['executedData']).toEqual({ rates: { value: { total: 3 } } });
	});

	test('what was decided about them goes to the core for the report, when there is something', async () => {
		await buildFrom('/s/kamado.config.jsonc', {}, '/s');
		expect(JSON.parse(finish.mock.calls[0]![1])).not.toHaveProperty('data');

		finish.mockClear();
		runAll.mockImplementation(() => {
			verbose?.('data rates: ran (5ms, hash a1b2c3d4)');
			return Promise.resolve();
		});
		await buildFrom('/s/kamado.config.jsonc', {}, '/s');

		expect(JSON.parse(finish.mock.calls[0]![1])).toMatchObject({
			data: ['data rates: ran (5ms, hash a1b2c3d4)'],
		});
	});
});
