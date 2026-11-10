/**
 * `kamado ui`, apart from the command line so that the order of what it does can be tested
 * with a program in place of the server: refuse what it does not take, read the flags, find
 * the config, and start. The flags are refused and read before the config is looked for, so
 * that a typo in a flag is not hidden behind a missing config file.
 */
import type { UiOnlyFlags, UiUnusedFlags } from './arguments.js';
import type { RunningUi, UiOptions } from './start.js';

import path from 'node:path';

import { checkUiArguments, parseOpen, parsePort } from './arguments.js';
import { ui } from './start.js';

/** The flags as `parseArgs` gives them, as far as `ui` reads them (or refuses them). */
export interface UiCommandFlags extends UiOnlyFlags, UiUnusedFlags {
	readonly 'cache-dir'?: string;
}

/** What the command needs from the process. */
export interface UiCommandEnvironment {
	/** The directory a relative `--cache-dir` is relative to. */
	readonly cwd: string;
	/**
	 * Finds the config file (`--config`, or the default).
	 * @throws {Error} when there is none
	 */
	readonly resolveConfig: () => string;
	/** Starts the editor (`ui()`; a test passes its own). */
	readonly run?: (configPath: string, options: UiOptions) => Promise<RunningUi>;
}

/**
 * Runs `kamado ui`.
 * @param positionals - The arguments after the command (it takes none)
 * @param flags - The flags that were given
 * @param environment - The directory, the config lookup and, for a test, the starter
 * @returns The running editor
 * @throws {Error} on an argument or a flag it does not take, a `--port` that is not one,
 * both `--open` and `--no-open`, a config that is not found, and what `ui()` throws
 * @example
 * ```ts
 * await uiCommand([], { port: '4000', 'no-open': true }, {
 * 	cwd: process.cwd(),
 * 	resolveConfig: () => '/site/kamado.config.jsonc',
 * });
 * ```
 */
export async function uiCommand(
	positionals: readonly string[],
	flags: UiCommandFlags,
	environment: UiCommandEnvironment,
): Promise<RunningUi> {
	checkUiArguments(positionals, flags);
	const port = parsePort(flags.port);
	const open = parseOpen(flags);
	const configPath = environment.resolveConfig();
	return (environment.run ?? ui)(configPath, {
		port,
		open,
		cacheDir:
			flags['cache-dir'] === undefined
				? undefined
				: path.resolve(environment.cwd, flags['cache-dir']),
	});
}
