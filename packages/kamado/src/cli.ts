#!/usr/bin/env node
/* eslint-disable no-console -- the CLI's job is to print */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs, styleText } from 'node:util';

import { build } from './build.js';
import { parseJobs } from './jobs.js';
import { start } from './server/start.js';
import { summarize } from './summary.js';

const USAGE = `Usage:
  kamado build [globs...] [--incremental] [--force] [--skip-unchanged]
                           [--jobs <n|auto>] [--cache-dir <dir>] [--config <file>] [--verbose]
  kamado server           [--config <file>] [--cache-dir <dir>] [--verbose]

The config file defaults to ./kamado.config.jsonc.`;

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
			const jobs = parseJobs(values.jobs);
			const progress = progressLine();
			let report;
			try {
				report = await build(configPath, {
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
				});
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
