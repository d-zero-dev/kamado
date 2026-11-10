/** The flags as `parseArgs` gives them, which `kamado ui` does not read. */
export interface UiUnusedFlags {
	readonly force?: boolean;
	readonly 'skip-unchanged'?: boolean;
	readonly verbose?: boolean;
	readonly incremental?: boolean;
	readonly jobs?: string;
	readonly out?: string;
}

/** The flags only `kamado ui` reads. */
export interface UiOnlyFlags {
	readonly port?: string;
	readonly open?: boolean;
	readonly 'no-open'?: boolean;
}

/**
 * Refuses what `ui` does not take: a position argument (it would read as the globs of
 * `build`) and the flags of the other commands (`--force` would not force anything). Said out
 * loud rather than ignored, as `pages` does.
 * @param positionals - The arguments after the command
 * @param flags - The flags that were given
 * @throws {Error} naming what is not taken
 * @example
 * ```ts
 * checkUiArguments([], { out: 'map.json' });
 * // Error: ui does not take --out (it takes --port, --open, --no-open, --cache-dir and --config)
 * ```
 */
export function checkUiArguments(
	positionals: readonly string[],
	flags: UiUnusedFlags,
): void {
	if (positionals.length > 0) {
		throw new Error('ui takes no arguments (it edits every page of the plan)');
	}
	const given: string[] = [];
	if (flags.out !== undefined) {
		given.push('--out');
	}
	if (flags.force) {
		given.push('--force');
	}
	if (flags.jobs !== undefined) {
		given.push('--jobs');
	}
	if (flags['skip-unchanged']) {
		given.push('--skip-unchanged');
	}
	if (flags.incremental) {
		given.push('--incremental');
	}
	if (flags.verbose) {
		given.push('--verbose');
	}
	if (given.length > 0) {
		throw new Error(
			`ui does not take ${given.join(', ')} (it takes --port, --open, --no-open, --cache-dir and --config)`,
		);
	}
}

/**
 * Refuses `--port`, `--open` and `--no-open` for the commands that have nothing to listen on
 * or to open.
 * @param command - The command
 * @param flags - The flags that were given
 * @throws {Error} naming the flags
 * @example
 * ```ts
 * checkUiOnlyFlags('build', { port: '3001' });
 * // Error: build does not take --port (only ui does)
 * ```
 */
export function checkUiOnlyFlags(command: string, flags: UiOnlyFlags): void {
	const given: string[] = [];
	if (flags.port !== undefined) {
		given.push('--port');
	}
	if (flags.open) {
		given.push('--open');
	}
	if (flags['no-open']) {
		given.push('--no-open');
	}
	if (given.length > 0) {
		throw new Error(`${command} does not take ${given.join(', ')} (only ui does)`);
	}
}

/**
 * Reads `--port`.
 * @param value - The flag, or `undefined`
 * @returns The port, or `undefined` for the default
 * @throws {Error} when it is not a whole number from 1 to 65535
 * @example
 * ```ts
 * parsePort('3001'); // 3001
 * parsePort(undefined); // undefined
 * ```
 */
export function parsePort(value?: string): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	// Not 0: a port the system picks is for the tests of the program API; on the loopback's
	// two addresses it may be free on one and taken on the other.
	if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65_535) {
		throw new Error(`--port takes a whole number from 1 to 65535, not "${value}"`);
	}
	return Number(value);
}

/**
 * Reads `--open` and `--no-open`.
 * @param flags - The flags that were given
 * @returns `true`, `false`, or `undefined` for `devServer.open`
 * @throws {Error} when both are given
 * @example
 * ```ts
 * parseOpen({ 'no-open': true }); // false
 * ```
 */
export function parseOpen(flags: UiOnlyFlags): boolean | undefined {
	if (flags.open && flags['no-open']) {
		throw new Error('--open and --no-open cannot be given together');
	}
	if (flags.open) {
		return true;
	}
	return flags['no-open'] ? false : undefined;
}
