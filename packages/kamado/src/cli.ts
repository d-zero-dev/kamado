#!/usr/bin/env node
/* eslint-disable no-console -- the CLI's job is to print */
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { parseArgs, styleText } from 'node:util';

import { buildFrom } from './build-from.js';
import { parseJobs } from './jobs.js';
import { checkPagesArguments, pagesCommand } from './pages-command.js';
import { start } from './server/start.js';
import { summarize } from './summary.js';
import { checkUiOnlyFlags } from './ui/arguments.js';
import { uiCommand } from './ui/command.js';
import { checkSettingsOnlyFlag, settingsCommand } from './ui/settings-command.js';
import { defaultSettingsFile } from './ui/settings.js';

const USAGE = `Usage:
  kamado build [globs...] [--incremental] [--force] [--skip-unchanged]
                           [--jobs <n|auto>] [--cache-dir <dir>] [--config <file>] [--verbose]
  kamado server           [--config <file>] [--cache-dir <dir>] [--verbose]
  kamado pages            [--out <file>] [--incremental] [--cache-dir <dir>] [--config <file>]
  kamado ui               [--port <n>] [--open | --no-open] [--cache-dir <dir>] [--config <file>]
  kamado ui-settings list
  kamado ui-settings reset [--config <file>]
  kamado ui-settings delete <config-file> | --all

The config file defaults to ./kamado.config.jsonc.
\`pages\` lists every page of the plan as JSON, without building: to the standard output, or
to --out.
\`ui\` opens a screen in the browser to edit the URLs and the metadata of the pages, to add
pages, to make a page virtual (its file goes, its URL stays) and to remove pages, and writes
them back to the source files. It listens on localhost, on the port of devServer plus one
unless --port says otherwise.
\`ui-settings\` looks at what \`ui\` saved in ~/.config/kamado/ui-settings.json, for each project:
\`list\` shows the projects, \`reset\` removes those of the project of the config file, and
\`delete\` removes those of the project of the given config file (or, with --all, those of every
project and the language).`;

/**
 * A progress line on the terminal's error stream, rewritten in place (and
 * nothing at all when that is not a terminal, so that logs stay clean).
 */
function progressLine(): {
	readonly update: (done: number, total: number) => void;
	readonly clear: () => void;
} {
	if (!process.stderr.isTTY) {
		return { update: () => {}, clear: () => {} };
	}
	let last = 0;
	let shown = false;
	return {
		update(done, total) {
			const now = performance.now();
			// Ten times a second is plenty, and the last count always shows.
			if (done < total && now - last < 100) {
				return;
			}
			last = now;
			shown = true;
			process.stderr.write(`\r${styleText('dim', `Rendering ${done}/${total}`)}`);
		},
		clear() {
			if (shown) {
				process.stderr.write('\r\u001B[K');
			}
		},
	};
}

/**
 * Resolves the config file: `--config` relative to the cwd, else
 * `kamado.config.jsonc` in the cwd. The path is the real one (symbolic links
 * resolved), as the cwd is: the input files and the globs of `build` are both
 * made from them, and a link on one side only would make no glob match.
 * @param configFlag - The `--config` value
 */
function resolveConfig(configFlag: string | undefined): string {
	const file = path.resolve(process.cwd(), configFlag ?? 'kamado.config.jsonc');
	if (!existsSync(file)) {
		throw new Error(`config file not found: ${file}`);
	}
	return realpathSync(file);
}

/**
 * Parses the command line and runs the command.
 * @param argv - Arguments without the node binary and script
 * @returns The process exit code
 */
async function main(argv: readonly string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: [...argv],
		allowPositionals: true,
		options: {
			config: { type: 'string', short: 'c' },
			verbose: { type: 'boolean', default: false },
			incremental: { type: 'boolean', default: false },
			force: { type: 'boolean', default: false },
			'skip-unchanged': { type: 'boolean', default: false },
			jobs: { type: 'string' },
			out: { type: 'string' },
			'cache-dir': { type: 'string' },
			port: { type: 'string' },
			open: { type: 'boolean', default: false },
			'no-open': { type: 'boolean', default: false },
			all: { type: 'boolean', default: false },
			help: { type: 'boolean', short: 'h', default: false },
		},
	});
	const [command, ...rest] = positionals;
	if (values.help || !command) {
		console.log(USAGE);
		return values.help ? 0 : 1;
	}
	// `--out` is a flag of `pages` alone; before `pages` took it, `parseArgs` refused it
	// for every command, and it must not become a flag that is silently ignored.
	if ((command === 'build' || command === 'server') && values.out !== undefined) {
		throw new Error(`${command} does not take --out (only pages writes a file)`);
	}
	// `--port` and `--open` are flags of `ui` alone: `parseArgs` takes them for every
	// command, and `build --port 3000` would otherwise be run with the flag silently ignored.
	// A command that does not exist is said so by the `default` of the switch, not by a flag.
	if (command !== 'ui' && ['build', 'server', 'pages'].includes(command)) {
		checkUiOnlyFlags(command, values);
	}
	// `--all` is a flag of `ui-settings` alone, and is refused for the others for the same reason.
	if (['build', 'server', 'pages', 'ui'].includes(command)) {
		checkSettingsOnlyFlag(command, values);
	}
	switch (command) {
		case 'build': {
			const configPath = resolveConfig(values.config);
			const jobs = parseJobs(values.jobs);
			const progress = progressLine();
			let report;
			try {
				// The globs typed at the prompt are relative to where they were typed.
				report = await buildFrom(
					configPath,
					{
						onProgress: progress.update,
						incremental: values.incremental,
						force: values.force,
						skipUnchanged: values['skip-unchanged'],
						targets: rest,
						jobs,
						cacheDir:
							values['cache-dir'] === undefined
								? undefined
								: path.resolve(process.cwd(), values['cache-dir']),
					},
					process.cwd(),
				);
			} finally {
				// An error message must not follow the progress line on the same row.
				progress.clear();
			}
			console.log(summarize(report, values.verbose));
			return 0;
		}
		case 'server': {
			await start(resolveConfig(values.config), {
				verbose: values.verbose,
				cacheDir:
					values['cache-dir'] === undefined
						? undefined
						: path.resolve(process.cwd(), values['cache-dir']),
			});
			// The server keeps the process alive; the exit code is decided by the
			// signal handlers it installed.
			return 0;
		}
		case 'pages': {
			checkPagesArguments(rest, values);
			pagesCommand(resolveConfig(values.config), {
				out: values.out,
				incremental: values.incremental,
				cacheDir:
					values['cache-dir'] === undefined
						? undefined
						: path.resolve(process.cwd(), values['cache-dir']),
			});
			return 0;
		}
		case 'ui': {
			await uiCommand(rest, values, {
				cwd: process.cwd(),
				resolveConfig: () => resolveConfig(values.config),
			});
			// The server keeps the process alive, as `server` does.
			return 0;
		}
		case 'ui-settings': {
			console.log(
				await settingsCommand(rest, values, {
					cwd: process.cwd(),
					file: defaultSettingsFile(),
					resolveConfig: () => resolveConfig(values.config),
				}),
			);
			return 0;
		}
		default: {
			console.error(styleText(['bold', 'red'], `unknown command: ${command}`));
			console.log(USAGE);
			return 1;
		}
	}
}

try {
	process.exitCode = await main(process.argv.slice(2));
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(styleText(['bold', 'red'], message));
	process.exitCode = 1;
}
