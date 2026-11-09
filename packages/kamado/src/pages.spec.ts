import { beforeEach, describe, expect, test, vi } from 'vitest';

const corePages = vi.fn<(configPath: string, optionsJson: string) => string>();

vi.mock('./native.js', () => ({
	native: () => ({ pages: corePages }),
}));

const { pages, pagesJson } = await import('./pages.js');

const MAP = JSON.stringify({
	version: 1,
	pages: [
		{
			url: '/about/',
			inputPath: '/s/src/about/index.html',
			outputPath: '/s/out/about/index.html',
			fileSlug: 'about',
			filePathStem: '/about/index',
			extension: '.html',
			depth: 1,
			parent: '/',
			virtual: false,
			meta: { title: 'About' },
		},
		{
			url: '/ext/',
			inputPath: null,
			outputPath: '/s/out/ext/index.html',
			fileSlug: 'ext',
			filePathStem: '/ext/index',
			extension: null,
			depth: 1,
			parent: '/',
			virtual: true,
			meta: { title: 'External' },
		},
	],
	warnings: ['a warning of the plan'],
});

describe('pages', () => {
	beforeEach(() => {
		corePages.mockReset();
		corePages.mockReturnValue(MAP);
	});

	test('returns the map the core wrote', async () => {
		const map = await pages('/s/kamado.config.jsonc');
		expect(map).toEqual(JSON.parse(MAP));
		expect(map.pages.map((p) => p.url)).toEqual(['/about/', '/ext/']);
		expect(map.pages[1]?.virtual).toBe(true);
		expect(map.warnings).toEqual(['a warning of the plan']);
	});

	test('asks the core for the config it was given and sends no option it was not given', async () => {
		await pages('/s/kamado.config.jsonc');
		expect(corePages).toHaveBeenCalledExactlyOnceWith('/s/kamado.config.jsonc', '{}');
	});

	test('sends the options as JSON', async () => {
		await pages('/s/kamado.config.jsonc', { incremental: true, cacheDir: '/tmp/c' });
		expect(corePages).toHaveBeenCalledExactlyOnceWith(
			'/s/kamado.config.jsonc',
			'{"incremental":true,"cacheDir":"/tmp/c"}',
		);
	});

	test('an error of the core is the error of the call', async () => {
		corePages.mockImplementation(() => {
			throw new Error('cannot read pages.overrides /s/missing.json');
		});
		await expect(pages('/s/kamado.config.jsonc')).rejects.toThrow(
			'cannot read pages.overrides /s/missing.json',
		);
	});
});

describe('pagesJson', () => {
	beforeEach(() => {
		corePages.mockReset();
		corePages.mockReturnValue(MAP);
	});

	test('gives the text of the core as it is', () => {
		expect(pagesJson('/s/kamado.config.jsonc', { incremental: false })).toBe(MAP);
		expect(corePages).toHaveBeenCalledExactlyOnceWith(
			'/s/kamado.config.jsonc',
			'{"incremental":false}',
		);
	});
});
