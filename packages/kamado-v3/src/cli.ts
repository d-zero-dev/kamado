#!/usr/bin/env node
/* eslint-disable no-console -- the CLI's job is to print */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs, styleText } from 'node:util';

import { build } from './build.js';
import { start } from './server/start.js';
import { summarize } from './summary.js';

const USAGE = `Usage:
  kamado build [globs...] [--incremental] [--force] [--skip-unchanged]
                          [--jobs <n>] [--cache-dir <dir>] [--config <file>] [--verbose]
  kamado server           [--config <file>] [--verbose]

The config file defaults to ./kamado.config.jsonc.`;

/**
 * Resolves the config file: `--config` relative to the cwd, else
 * `kamado.config.jsonc` in the cwd.
 * @param configFlag - The `--config` value
 */
function resolveConfig(configFlag: string | undefined): string {
	const file = path.resolve(process.cwd(), configFlag ?? 'kamado.config.jsonc');
	if (!existsSync(file)) {
		throw new Error(`config file not found: ${file}`);
	}
	return file;
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
			'cache-dir': { type: 'string' },
			help: { type: 'boolean', short: 'h', default: false },
		},
	});
	const [command, ...rest] = positionals;
	if (values.help || !command) {
		console.log(USAGE);
		return values.help ? 0 : 1;
	}
	switch (command) {
		case 'build': {
			const configPath = resolveConfig(values.config);
			const jobs = values.jobs === undefined ? undefined : Number(values.jobs);
			if (jobs !== undefined && (!Number.isInteger(jobs) || jobs < 1)) {
				throw new Error(`--jobs must be a positive integer: ${values.jobs}`);
			}
			const report = await build(configPath, {
				incremental: values.incremental,
				force: values.force,
				skipUnchanged: values['skip-unchanged'],
				targets: rest,
				jobs,
				cacheDir:
					values['cache-dir'] === undefined
						? undefined
						: path.resolve(process.cwd(), values['cache-dir']),
			});
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
