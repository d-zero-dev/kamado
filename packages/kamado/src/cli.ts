#!/usr/bin/env node

import path from 'node:path';

import { parseCli } from '@d-zero/roar';
import c from 'ansi-colors';

import { build } from './builder/build.js';
import { getConfigWithPath } from './config/get-config.js';
import { pathResolver } from './path/resolver.js';
import { start } from './server/app.js';

const commonFlags = {
	config: {
		type: 'string' as const,
		shortFlag: 'c',
		desc: 'Path to config file',
	},
	verbose: {
		type: 'boolean' as const,
		desc: 'Enable verbose logging',
	},
} as const;

const cli = parseCli({
	name: 'kamado',
	commands: {
		build: {
			desc: 'Build static files',
			flags: {
				...commonFlags,
				skipUnchanged: {
					type: 'boolean' as const,
					desc: 'Skip writing output files whose content is unchanged',
				},
				incremental: {
					type: 'boolean' as const,
					desc: 'Skip compiling outputs whose recorded inputs are unchanged (cache defaults to a folder under the OS temp directory)',
				},
				force: {
					type: 'boolean' as const,
					desc: 'With --incremental, ignore the existing cache and rebuild everything, then refresh it',
				},
				cacheDir: {
					type: 'string' as const,
					desc: 'Directory for the incremental-build cache (default: a project-specific folder under the OS temp directory)',
				},
			},
		},
		server: {
			desc: 'Start development server',
			flags: {
				...commonFlags,
			},
		},
	},
	onError(error: Error) {
		// eslint-disable-next-line no-console
		console.error(c.bold.red(error.message));
		return true;
	},
});

const configPath = cli.flags.config
	? path.resolve(process.cwd(), cli.flags.config)
	: undefined;
const { config, filepath: configFilePath } = await getConfigWithPath(configPath).catch(
	(error: Error) => {
		// eslint-disable-next-line no-console
		console.error(c.bold.red(error.message));
		process.exit(1);
	},
);

switch (cli.command) {
	case 'build': {
		await build({
			...config,
			// Anchor the build (and the incremental manifest under
			// .kamado/cache/) to the config file's directory, not the invoking
			// cwd; build() re-merges config and would otherwise fall back to
			// process.cwd() for dir.root. Falls back to cwd when no config file
			// was found (cosmiconfig searched from cwd anyway).
			rootDir: configFilePath ? path.dirname(configFilePath) : undefined,
			targetGlob: pathResolver(cli.args),
			verbose: cli.flags.verbose,
			skipUnchanged: cli.flags.skipUnchanged,
			incremental: cli.flags.incremental,
			force: cli.flags.force,
			// Resolve --cache-dir against the invoking cwd (like --config), so a
			// relative path means what the user typed at the prompt
			cacheDir: cli.flags.cacheDir
				? path.resolve(process.cwd(), cli.flags.cacheDir)
				: undefined,
			configFilePath,
		});
		break;
	}
	case 'server': {
		void start(config, { verbose: cli.flags.verbose });
		break;
	}
}
