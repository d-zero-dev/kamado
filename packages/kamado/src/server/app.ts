import type { Config, Context } from '../config/types.js';
import type { MetaData } from '../files/types.js';

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
export async function start<M extends MetaData>(config: Config<M>) {
	// Create execution context
	const context: Context<M> = {
		...config,
		mode: 'serve',
	};

	const app = new Hono();

	await setRoute({ app, context });

	serve({
		fetch: app.fetch,
		hostname: context.devServer.host,
		port: context.devServer.port,
	});

	const baseUrl = new URL(`http://${context.devServer.host}:${context.devServer.port}`);
	baseUrl.pathname = context.devServer.startPath ?? '';

	const location = baseUrl.toString();
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
