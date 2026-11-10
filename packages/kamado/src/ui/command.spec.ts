import type { RunningUi, UiOptions } from './start.js';

import { describe, expect, test, vi } from 'vitest';

import { uiCommand } from './command.js';

const RUNNING: RunningUi = {
	url: 'http://localhost:3001/',
	close: () => Promise.resolve(),
};

/**
 * What the command is given in place of the process.
 * @param config - What the config lookup does
 */
function environment(config: () => string = () => '/site/kamado.config.jsonc') {
	const run = vi.fn<(configPath: string, options: UiOptions) => Promise<RunningUi>>(() =>
		Promise.resolve(RUNNING),
	);
	const resolveConfig = vi.fn(config);
	return { run, resolveConfig, env: { cwd: '/work', resolveConfig, run } };
}

describe('uiCommand', () => {
	test('starts the editor on the config, with nothing set when no flag is given', async () => {
		const { run, env } = environment();
		await expect(uiCommand([], {}, env)).resolves.toBe(RUNNING);
		expect(run).toHaveBeenCalledWith('/site/kamado.config.jsonc', {
			port: undefined,
			open: undefined,
			cacheDir: undefined,
		});
	});

	test('takes the port, the browser and the cache directory from the flags', async () => {
		const { run, env } = environment();
		await uiCommand([], { port: '4000', 'no-open': true, 'cache-dir': '.cache' }, env);
		expect(run).toHaveBeenCalledWith('/site/kamado.config.jsonc', {
			port: 4000,
			open: false,
			cacheDir: '/work/.cache',
		});
		await uiCommand([], { open: true, 'cache-dir': '/abs/cache' }, env);
		expect(run).toHaveBeenLastCalledWith('/site/kamado.config.jsonc', {
			port: undefined,
			open: true,
			cacheDir: '/abs/cache',
		});
	});

	test.each([
		['an argument', ['src/**'], {}, /takes no arguments/],
		['--out', [], { out: 'a.json' }, /does not take --out/],
		['--incremental', [], { incremental: true }, /does not take --incremental/],
		['a port that is not one', [], { port: 'abc' }, /--port/],
		['a port of 0', [], { port: '0' }, /--port/],
		['both --open and --no-open', [], { open: true, 'no-open': true }, /together/],
	])(
		'%s is refused before the config is looked for and before anything starts',
		async (_name, positionals, flags, message) => {
			const { run, resolveConfig, env } = environment();
			await expect(uiCommand(positionals, flags, env)).rejects.toThrow(message);
			expect(resolveConfig).not.toHaveBeenCalled();
			expect(run).not.toHaveBeenCalled();
		},
	);

	test('a config that is not found stops it before anything starts', async () => {
		const { run, env } = environment(() => {
			throw new Error('config file not found: /work/kamado.config.jsonc');
		});
		await expect(uiCommand([], {}, env)).rejects.toThrow(/config file not found/);
		expect(run).not.toHaveBeenCalled();
	});

	test('what the editor throws is what the command throws', async () => {
		const { run, env } = environment();
		run.mockRejectedValue(new Error('port 4000 is already in use'));
		await expect(uiCommand([], { port: '4000' }, env)).rejects.toThrow(/already in use/);
	});
});
