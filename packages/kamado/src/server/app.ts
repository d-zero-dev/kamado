import type { Config, Context } from '../config/types.js';

import path from 'node:path';

import { serve } from '@hono/node-server';
import c from 'ansi-colors';
import { Hono } from 'hono';
import open from 'open';

import { setRoute } from './route.js';

/**
 * Starts the development server
 * @param config - Configuration object
 */
export async function start(config: Config) {
	// Create execution context
	const context: Context = {
		...config,
		mode: 'serve',
	};

	const app = new Hono();

	await setRoute(app, context);

	serve({
		fetch: app.fetch,
		hostname: context.devServer.host,
		port: context.devServer.port,
	});

	const location = `http://${context.devServer.host}:${context.devServer.port}`;
	const relDocumentRoot =
		'.' + path.sep + path.relative(process.cwd(), context.dir.input);

	process.stdout.write(`
  ${c.bold.greenBright('Kamado Dev Server: Ignition🔥')}

  ${c.blue('Location')}: ${c.bold(location)}
  ${c.blue('DocumentRoot')}: ${c.bold.gray(relDocumentRoot)}
`);

	if (context.devServer.open) {
		await open(location);
	}
}
