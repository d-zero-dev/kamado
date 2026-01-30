#!/usr/bin/env node

import path from 'node:path';

import { roar } from '@d-zero/roar';
import c from 'ansi-colors';

import { build } from './builder/index.js';
import { getConfig } from './config/get-config.js';
import { pathResolver } from './path/resolver.js';
import { start } from './server/app.js';

const cli = roar({
	name: 'kamado',
	commands: {
		build: {
			desc: 'Build static files',
		},
		server: {
			desc: 'Start development server',
		},
	},
	flags: {
		config: {
			type: 'string',
			shortFlag: 'c',
			desc: 'Path to config file',
		},
		verbose: {
			type: 'boolean',
			desc: 'Enable verbose logging',
		},
	},
	onError(error) {
		// eslint-disable-next-line no-console
		console.error(c.bold.red(error.message));
		return true;
	},
});

const configPath = cli.flags.config
	? path.resolve(process.cwd(), cli.flags.config)
	: undefined;
const config = await getConfig(configPath).catch((error: Error) => {
	// eslint-disable-next-line no-console
	console.error(c.bold.red(error.message));
	process.exit(1);
});

switch (cli.command) {
	case 'build': {
		await build({
			...config,
			targetGlob: pathResolver(cli.args),
			verbose: cli.flags.verbose,
		});
		break;
	}
	case 'server': {
		void start(config);
		break;
	}
}
