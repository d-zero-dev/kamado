/**
 * `kamado ui-settings list | reset | delete`: what the screen of `kamado ui` has saved
 * (RFC section 14.2, `settings.ts`), looked at and removed from the command line. It is a
 * command of its own and not flags of `ui`, which takes no argument: this one has to work for
 * projects that are not open, and for ones whose directory is gone.
 *
 * It returns the text to print rather than printing it, so that what it says can be tested.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import {
	listSettings,
	removeAllSettings,
	removeProjectSettings,
	type Listed,
} from './settings.js';

/** The name of the config file a directory is taken to hold. */
const DEFAULT_CONFIG = 'kamado.config.jsonc';

/** The flags as `parseArgs` gives them, as far as `ui-settings` reads them (or refuses them). */
export interface SettingsCommandFlags {
	readonly all?: boolean;
	readonly config?: string;
	readonly force?: boolean;
	readonly 'skip-unchanged'?: boolean;
	readonly verbose?: boolean;
	readonly incremental?: boolean;
	readonly jobs?: string;
	readonly out?: string;
	readonly 'cache-dir'?: string;
	readonly port?: string;
	readonly open?: boolean;
	readonly 'no-open'?: boolean;
}

/** What the command needs from the process. */
export interface SettingsCommandEnvironment {
	/** The directory a relative path is relative to. */
	readonly cwd: string;
	/** The settings file. */
	readonly file: string;
	/**
	 * Finds the config file (`--config`, or the default): for `reset` only.
	 * @throws {Error} when there is none
	 */
	readonly resolveConfig: () => string;
}

/**
 * Refuses the flags the command does not read.
 * @param flags - The flags that were given
 * @throws {Error} naming them
 */
function checkUnused(flags: SettingsCommandFlags): void {
	const given: string[] = [];
	const names: [string, unknown][] = [
		['--cache-dir', flags['cache-dir']],
		['--force', flags.force || undefined],
		['--incremental', flags.incremental || undefined],
		['--jobs', flags.jobs],
		['--no-open', flags['no-open'] || undefined],
		['--open', flags.open || undefined],
		['--out', flags.out],
		['--port', flags.port],
		['--skip-unchanged', flags['skip-unchanged'] || undefined],
		['--verbose', flags.verbose || undefined],
	];
	for (const [name, value] of names) {
		if (value !== undefined) {
			given.push(name);
		}
	}
	if (given.length > 0) {
		throw new Error(
			`ui-settings does not take ${given.join(', ')} (it takes --all with delete and --config with reset)`,
		);
	}
}

/**
 * The keys a path may mean: the real path of the config file (or of the one in the directory
 * given), and the path as it was written, for a project whose files are gone and that is
 * listed by the path it had.
 * @param given - The argument
 * @param cwd - What a relative path is relative to
 */
function candidates(given: string, cwd: string): string[] {
	const resolved = path.resolve(cwd, given);
	const found: string[] = [];
	try {
		const file = statSync(resolved).isDirectory()
			? path.join(resolved, DEFAULT_CONFIG)
			: resolved;
		found.push(realpathSync(file));
	} catch {
		// Not there any more: only the path as written can name it.
	}
	found.push(resolved);
	return found;
}

/**
 * A text of the file for the terminal, with the control characters written out: the file is
 * edited by hand (or by something else), and an escape sequence in it must not reach the
 * terminal as one.
 * @param text - Text from the settings file
 * @example
 * ```ts
 * printable('/a\u001B[31m'); // '/a\\x1b[31m'
 * ```
 */
function printable(text: string): string {
	return text.replaceAll(
		// eslint-disable-next-line no-control-regex -- the control characters are what this finds
		/[\u0000-\u001F\u007F]/g,
		(char) => `\\x${(char.codePointAt(0) ?? 0).toString(16).padStart(2, '0')}`,
	);
}

/**
 * What `list` says.
 * @param file - The settings file
 * @param listed - What the file holds
 */
function describeList(file: string, listed: Listed): string {
	switch (listed.state) {
		case 'missing': {
			return `No settings are saved (${file} does not exist)`;
		}
		case 'newer': {
			return `${file} was written by a newer kamado (version ${listed.version}): update kamado to read it`;
		}
		case 'broken': {
			return `${file} cannot be read (${listed.reason}). Nothing was changed; "kamado ui-settings delete --all" removes it`;
		}
		default: {
			if (listed.projects.length === 0) {
				return `No settings are saved for any project (${file}; language: ${listed.global.locale})`;
			}
			const lines = listed.projects.map(
				({ key, updatedAt }) =>
					`  ${printable(key)}${updatedAt === '' ? '' : `  (saved ${printable(updatedAt)})`}${existsSync(key) ? '' : '  [config file not found]'}`,
			);
			return [
				`${file} (language: ${listed.global.locale})`,
				`${listed.projects.length} project(s):`,
				...lines,
			].join('\n');
		}
	}
}

/**
 * Runs `kamado ui-settings`.
 * @param positionals - The arguments after the command
 * @param flags - The flags that were given
 * @param environment - The directory, the settings file and the config lookup
 * @returns The text to print
 * @throws {Error} on an argument or flag it does not take, a project that has no settings,
 * a config that is not found (`reset`), and a file of a newer version that would be written
 * @example
 * ```ts
 * await settingsCommand(['list'], {}, { cwd: process.cwd(), file, resolveConfig });
 * ```
 */
export async function settingsCommand(
	positionals: readonly string[],
	flags: SettingsCommandFlags,
	environment: SettingsCommandEnvironment,
): Promise<string> {
	checkUnused(flags);
	const [sub, ...rest] = positionals;
	if (sub !== 'list' && sub !== 'reset' && sub !== 'delete') {
		throw new Error('ui-settings takes list, reset or delete');
	}
	if (sub !== 'delete' && flags.all) {
		throw new Error(`${sub} does not take --all (only delete does)`);
	}
	if (sub !== 'reset' && flags.config !== undefined) {
		throw new Error(`${sub} does not take --config (only reset does)`);
	}
	if (sub !== 'delete' && rest.length > 0) {
		throw new Error(`${sub} takes no arguments`);
	}
	const { file } = environment;
	if (sub === 'list') {
		return describeList(file, await listSettings(file));
	}
	if (sub === 'reset') {
		const key = environment.resolveConfig();
		const { removed, warning } = await removeProjectSettings(file, key);
		return [
			removed ? `Reset the settings of ${key}` : `No settings were saved for ${key}`,
			...(warning === null ? [] : [`warning: ${warning}`]),
		].join('\n');
	}
	if (flags.all) {
		if (rest.length > 0) {
			throw new Error('delete takes a path or --all, not both');
		}
		return (await removeAllSettings(file))
			? `Deleted ${file}`
			: `Nothing to delete (${file} does not exist)`;
	}
	if (rest.length !== 1 || rest[0] === undefined) {
		throw new Error('delete takes the path of a config file, or --all');
	}
	const given = rest[0];
	const listed = await listSettings(file);
	if (listed.state === 'newer' || listed.state === 'broken') {
		throw new Error(describeList(file, listed));
	}
	const keys = new Set(listed.state === 'ok' ? listed.projects.map((p) => p.key) : []);
	const key = candidates(given, environment.cwd).find((candidate) => keys.has(candidate));
	if (key === undefined) {
		throw new Error(
			`no settings are saved for ${given} ("kamado ui-settings list" shows the projects that have some)`,
		);
	}
	const { removed, warning } = await removeProjectSettings(file, key);
	if (!removed) {
		// Another kamado removed it between the listing and this.
		throw new Error(`no settings are saved for ${given} any more`);
	}
	return [
		`Deleted the settings of ${key}`,
		...(warning === null ? [] : [`warning: ${warning}`]),
	].join('\n');
}

export { checkSettingsOnlyFlag } from '../cli-arguments.js';
