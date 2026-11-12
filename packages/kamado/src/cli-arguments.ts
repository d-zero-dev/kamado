/**
 * Which position arguments and flags each CLI command takes. `parseArgs` declares every
 * flag for every command; this table is what refuses the ones a command does not read,
 * so a typo is not silently ignored (RFC §13).
 */

/** A flag name as `parseArgs` gives it (without the leading `--`). */
export type CliFlag =
	| 'config'
	| 'cache-dir'
	| 'verbose'
	| 'incremental'
	| 'force'
	| 'skip-unchanged'
	| 'jobs'
	| 'out'
	| 'port'
	| 'open'
	| 'no-open'
	| 'all'
	| 'yes';

/** The flags as `parseArgs` gives them. */
export type CliFlags = {
	readonly [K in CliFlag]?: K extends 'config' | 'cache-dir' | 'jobs' | 'out' | 'port'
		? string
		: boolean;
};

/** One command's allowlist. */
interface CommandAllowlist {
	/** Whether positionals after the command name are taken. */
	readonly positionals: boolean;
	/** Said when a positional is refused. */
	readonly noPositionals?: string;
	/** Flags this command reads (`--help` is handled before the table). */
	readonly allowed: readonly CliFlag[];
	/** The "it takes …" clause of a refusal that lists what the command reads. */
	readonly takes: string;
}

const COMMON = ['config', 'cache-dir'] as const satisfies readonly CliFlag[];

/**
 * The commands of the CLI and what each takes. `ui-settings` keeps its own checks: its
 * flags depend on the subcommand (`--all` with delete, `--config` with reset).
 */
export const COMMAND_ALLOWLIST: Readonly<Record<string, CommandAllowlist>> = {
	build: {
		positionals: true,
		allowed: [...COMMON, 'verbose', 'incremental', 'force', 'skip-unchanged', 'jobs'],
		takes:
			'--incremental, --force, --skip-unchanged, --jobs, --verbose, --cache-dir and --config',
	},
	server: {
		positionals: false,
		noPositionals: 'server takes no arguments',
		allowed: [...COMMON, 'verbose'],
		takes: '--verbose, --cache-dir and --config',
	},
	pages: {
		positionals: false,
		noPositionals: 'pages takes no arguments (it lists every page of the plan)',
		allowed: [...COMMON, 'out', 'incremental'],
		takes: '--out, --incremental, --cache-dir and --config',
	},
	ui: {
		positionals: false,
		noPositionals: 'ui takes no arguments (it edits every page of the plan)',
		allowed: [...COMMON, 'port', 'open', 'no-open'],
		takes: '--port, --open, --no-open, --cache-dir and --config',
	},
	sync: {
		positionals: true,
		allowed: [...COMMON, 'yes'],
		takes: '--yes, --cache-dir and --config',
	},
};

/** How a flag is written on the command line. */
const FLAG_CLI: Record<CliFlag, string> = {
	config: '--config',
	'cache-dir': '--cache-dir',
	verbose: '--verbose',
	incremental: '--incremental',
	force: '--force',
	'skip-unchanged': '--skip-unchanged',
	jobs: '--jobs',
	out: '--out',
	port: '--port',
	open: '--open',
	'no-open': '--no-open',
	all: '--all',
	yes: '--yes',
};

/**
 * Ownership clauses used when every refused flag belongs to one other command. Saying
 * "only pages writes a file" is clearer than listing every flag the command takes, for the
 * flags that used to have that wording.
 */
const ONLY: Partial<Record<CliFlag, string>> = {
	out: 'only pages writes a file',
	port: 'only ui does',
	open: 'only ui does',
	'no-open': 'only ui does',
	all: 'only ui-settings delete does',
	yes: 'only sync does',
};

/** Every flag `parseArgs` may set, in a stable order for refusals. */
const ALL_FLAGS: readonly CliFlag[] = [
	'all',
	'cache-dir',
	'config',
	'force',
	'incremental',
	'jobs',
	'no-open',
	'open',
	'out',
	'port',
	'skip-unchanged',
	'verbose',
	'yes',
];

/**
 * Whether `parseArgs` treated the flag as given. Booleans default to `false`, so only
 * `true` counts; string options count when they are defined (including an empty `--out`).
 * @param name - The flag
 * @param flags - What `parseArgs` returned
 */
function wasGiven(name: CliFlag, flags: CliFlags): boolean {
	const value = flags[name];
	if (typeof value === 'boolean') {
		return value;
	}
	return value !== undefined;
}

/**
 * Refuses positionals and flags the command does not take.
 * @param command - The command name (`build`, `server`, `pages`, `ui`, `sync`)
 * @param positionals - Arguments after the command
 * @param flags - What `parseArgs` returned
 * @throws {Error} naming what is not taken
 * @example
 * ```ts
 * checkCommandArguments('server', ['foo'], { force: true });
 * // Error: server takes no arguments
 * ```
 */
export function checkCommandArguments(
	command: string,
	positionals: readonly string[],
	flags: CliFlags,
): void {
	const spec = COMMAND_ALLOWLIST[command];
	if (spec === undefined) {
		return;
	}
	if (!spec.positionals && positionals.length > 0) {
		throw new Error(spec.noPositionals ?? `${command} takes no arguments`);
	}
	const allowed = new Set<CliFlag>(spec.allowed);
	const given: CliFlag[] = [];
	for (const name of ALL_FLAGS) {
		if (!allowed.has(name) && wasGiven(name, flags)) {
			given.push(name);
		}
	}
	if (given.length === 0) {
		return;
	}
	const names = given.map((name) => FLAG_CLI[name]);
	const only = ONLY[given[0]!];
	const sameOnly = only !== undefined && given.every((name) => ONLY[name] === only);
	if (sameOnly) {
		throw new Error(`${command} does not take ${names.join(', ')} (${only})`);
	}
	throw new Error(
		`${command} does not take ${names.join(', ')} (it takes ${spec.takes})`,
	);
}

/**
 * Refuses `--all` for commands that are not `ui-settings` (kept for the settings-command
 * tests and for callers that only need that check).
 * @param command - The command
 * @param flags - The flags that were given
 * @throws {Error} naming the flag
 * @example
 * ```ts
 * checkSettingsOnlyFlag('build', { all: true });
 * // Error: build does not take --all (only ui-settings delete does)
 * ```
 */
export function checkSettingsOnlyFlag(
	command: string,
	flags: Pick<CliFlags, 'all'>,
): void {
	if (flags.all) {
		throw new Error(`${command} does not take --all (only ui-settings delete does)`);
	}
}
