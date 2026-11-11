import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const pagesJson =
	vi.fn<
		(configPath: string, options: { incremental?: boolean; cacheDir?: string }) => string
	>();

vi.mock('./pages.js', () => ({
	pagesJson: (
		configPath: string,
		options: { incremental?: boolean; cacheDir?: string },
	) => pagesJson(configPath, options),
}));

const { pagesCommand } = await import('./pages-command.js');

/**
 * The text of a map of `count` pages.
 * @param count - How many pages
 */
function mapOf(count: number): string {
	return JSON.stringify({
		version: 1,
		pages: Array.from({ length: count }, (_, i) => ({ url: `/p${i}/` })),
		warnings: [],
	});
}

let dir: string;
let stdout: string[];
let stderr: string[];
let clock: number[];

/**
 * The streams and the clock the command is run with.
 */
function io() {
	return {
		cwd: dir,
		stdout: (text: string) => stdout.push(text),
		stderr: (text: string) => stderr.push(text),
		now: () => clock.shift() ?? 0,
	};
}

describe('pagesCommand', () => {
	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), 'kd-pages-command-'));
		stdout = [];
		stderr = [];
		// The time before the plan and the time after it: 0.8s.
		clock = [100, 900];
		pagesJson.mockReset();
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test('without --out the map goes to the standard output and the progress to the standard error', () => {
		pagesJson.mockReturnValue(mapOf(1234));
		pagesCommand('/s/kamado.config.jsonc', { incremental: false }, io());
		expect(stdout).toEqual([`${mapOf(1234)}\n`]);
		expect(stderr).toEqual(['Reading pages...\n', 'Listed 1,234 pages in 0.8s\n']);
	});

	test('with --out the map goes to the file, relative to the directory it is run in, and nothing to the standard output', () => {
		pagesJson.mockReturnValue(mapOf(1234));
		pagesCommand(
			'/s/kamado.config.jsonc',
			{ incremental: false, out: 'maps/map.json' },
			io(),
		);
		expect(readFileSync(path.join(dir, 'maps', 'map.json'), 'utf8')).toBe(
			`${mapOf(1234)}\n`,
		);
		expect(stdout).toEqual([]);
		expect(stderr).toEqual([
			'Reading pages...\n',
			'Wrote maps/map.json (1,234 pages) in 0.8s\n',
		]);
	});

	test('an absolute --out is used as it is', () => {
		pagesJson.mockReturnValue(mapOf(2));
		const out = path.join(dir, 'abs.json');
		pagesCommand('/s/kamado.config.jsonc', { incremental: false, out }, io());
		expect(existsSync(out)).toBe(true);
		expect(stderr.at(-1)).toBe(`Wrote ${out} (2 pages) in 0.8s\n`);
	});

	test('one page is one page, and none is none', () => {
		pagesJson.mockReturnValue(mapOf(1));
		pagesCommand('/s/kamado.config.jsonc', { incremental: false }, io());
		expect(stderr.at(-1)).toBe('Listed 1 page in 0.8s\n');

		stderr.length = 0;
		clock = [0, 0];
		pagesJson.mockReturnValue(mapOf(0));
		pagesCommand('/s/kamado.config.jsonc', { incremental: false }, io());
		expect(stderr.at(-1)).toBe('Listed 0 pages in 0.0s\n');
	});

	test('tells that it is reading before the plan, which does not give the terminal back', () => {
		pagesJson.mockImplementation(() => {
			expect(stderr).toEqual(['Reading pages...\n']);
			return mapOf(1);
		});
		pagesCommand('/s/kamado.config.jsonc', { incremental: false }, io());
		expect(pagesJson).toHaveBeenCalledOnce();
	});

	test('the warnings of the plan are on the standard error, one line each, before the last line; the map is not changed', () => {
		const text = JSON.stringify({
			version: 1,
			pages: [{ url: '/' }],
			warnings: ['output path conflict: /a.html', 'plan cache: cannot write'],
		});
		pagesJson.mockReturnValue(text);
		pagesCommand('/s/kamado.config.jsonc', { incremental: false, out: 'map.json' }, io());
		expect(stderr).toEqual([
			'Reading pages...\n',
			'warning: output path conflict: /a.html\n',
			'warning: plan cache: cannot write\n',
			'Wrote map.json (1 page) in 0.8s\n',
		]);
		expect(readFileSync(path.join(dir, 'map.json'), 'utf8')).toBe(`${text}\n`);
	});

	test('hands --incremental and --cache-dir to the core', () => {
		pagesJson.mockReturnValue(mapOf(1));
		pagesCommand(
			'/s/kamado.config.jsonc',
			{ incremental: true, cacheDir: '/tmp/cache' },
			io(),
		);
		expect(pagesJson).toHaveBeenCalledExactlyOnceWith('/s/kamado.config.jsonc', {
			incremental: true,
			cacheDir: '/tmp/cache',
		});
	});

	test('an empty --out is refused before the plan is read', () => {
		expect(() => {
			pagesCommand('/s/kamado.config.jsonc', { incremental: false, out: '' }, io());
		}).toThrow('--out needs a file name');
		expect(pagesJson).not.toHaveBeenCalled();
		expect(stderr).toEqual([]);
	});

	test('a file that cannot be written says which one, and the end is not said as done', () => {
		pagesJson.mockReturnValue(mapOf(3));
		// A directory is not a file that can be written.
		mkdirSync(path.join(dir, 'maps'));
		expect(() => {
			pagesCommand('/s/kamado.config.jsonc', { incremental: false, out: 'maps' }, io());
		}).toThrow(/^cannot write maps: .*EISDIR/);
		expect(stdout).toEqual([]);
		expect(stderr).toEqual(['Reading pages...\n']);
	});

	test('an error of the core is thrown, and nothing is written or said as done', () => {
		pagesJson.mockImplementation(() => {
			throw new Error('cannot read pages.overrides /s/missing.json');
		});
		expect(() =>
			pagesCommand(
				'/s/kamado.config.jsonc',
				{ incremental: false, out: 'map.json' },
				io(),
			),
		).toThrow('cannot read pages.overrides');
		expect(existsSync(path.join(dir, 'map.json'))).toBe(false);
		expect(stdout).toEqual([]);
		expect(stderr).toEqual(['Reading pages...\n']);
	});
});
