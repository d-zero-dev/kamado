#!/usr/bin/env node

import { roar } from '@d-zero/roar';
import c from 'ansi-colors';

import { build } from './builder/index.js';
import { getConfig } from './config/load.js';
import { pathResolver } from './path/resolver.js';
import { start } from './server/app.js';

const config = await getConfig();

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
