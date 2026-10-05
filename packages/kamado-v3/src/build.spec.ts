import { beforeEach, describe, expect, test, vi } from 'vitest';

const nativeBuild = vi.fn<(configPath: string, optionsJson: string) => string>();

vi.mock('./native.js', () => ({
	native: () => ({ build: nativeBuild }),
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

describe('build', () => {
	beforeEach(() => {
		nativeBuild.mockReset();
		nativeBuild.mockReturnValue(REPORT);
	});

	test('passes the config path and the options as JSON to the core', () => {
		build('/site/kamado.config.jsonc', {
			incremental: true,
			force: false,
			targets: ['sub/**'],
			jobs: 4,
			cacheDir: '/cache',
		});

		expect(nativeBuild).toHaveBeenCalledExactlyOnceWith(
			'/site/kamado.config.jsonc',
			'{"incremental":true,"force":false,"targets":["sub/**"],"jobs":4,"cacheDir":"/cache"}',
		);
	});

	test('without options the core receives an empty object', () => {
		build('/site/kamado.config.jsonc');

		expect(nativeBuild).toHaveBeenCalledExactlyOnceWith(
			'/site/kamado.config.jsonc',
			'{}',
		);
	});

	test('returns the report the core produced, parsed', () => {
		expect(build('/site/kamado.config.jsonc')).toEqual({
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

	test('errors thrown by the core reach the caller unchanged', () => {
		nativeBuild.mockImplementation(() => {
			throw new Error('/site/kamado.config.jsonc: pages.file: unknown option');
		});

		expect(() => build('/site/kamado.config.jsonc')).toThrow(
			'/site/kamado.config.jsonc: pages.file: unknown option',
		);
	});
});
