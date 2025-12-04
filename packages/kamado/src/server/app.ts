import type { Config } from '../config/types.js';

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
	const app = new Hono();

	await setRoute(app, config);

	serve({
		fetch: app.fetch,
		hostname: config.devServer.host,
		port: config.devServer.port,
	});

	const location = `http://${config.devServer.host}:${config.devServer.port}`;
	const relDocumentRoot = '.' + path.sep + path.relative(process.cwd(), config.dir.input);

	process.stdout.write(`
  ${c.bold.greenBright('Kamado Dev Server: Ignition🔥')}

  ${c.blue('Location')}: ${c.bold(location)}
  ${c.blue('DocumentRoot')}: ${c.bold.gray(relDocumentRoot)}
`);

	if (config.devServer.open) {
		await open(location);
	}
}
