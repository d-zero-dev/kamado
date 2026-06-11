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
					desc: 'Skip compiling outputs whose recorded inputs are unchanged (uses .kamado/cache/build-manifest.json)',
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
			targetGlob: pathResolver(cli.args),
			verbose: cli.flags.verbose,
			skipUnchanged: cli.flags.skipUnchanged,
			incremental: cli.flags.incremental,
			configFilePath,
		});
		break;
	}
	case 'server': {
		void start(config, { verbose: cli.flags.verbose });
		break;
	}
}
