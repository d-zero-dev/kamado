import type { Config, Context } from '../config/types.js';
import type { MetaData } from '../files/types.js';

import path from 'node:path';

import { serve } from '@hono/node-server';
import c from 'ansi-colors';
import { Hono } from 'hono';
import open from 'open';

import { setProxyRoutes } from './proxy.js';
import { setRoute } from './route.js';

/**
 * Options for starting the development server
 */
export interface StartOptions {
	readonly verbose?: boolean;
}

/**
 * Starts the development server
 * @template M - Custom metadata type extending MetaData
 * @param config - Configuration object
 * @param options - Server start options
 * @returns Resolves when the server is started and the browser is opened (if configured)
 */
export async function start<M extends MetaData>(
	config: Config<M>,
	options?: StartOptions,
) {
	// Create execution context
	const context: Context<M> = {
		...config,
		mode: 'serve',
	};

	const app = new Hono();

	if (context.devServer.proxy) {
		setProxyRoutes(app, context.devServer.proxy);
	}

	await setRoute({ app, context }, { verbose: options?.verbose });

	const server = serve({
		fetch: app.fetch,
		hostname: context.devServer.host,
		port: context.devServer.port,
	});

	// Graceful shutdown on process signals
	const shutdown = () => {
		server.close(() => {
			process.exit(0);
		});
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	const baseUrl = new URL(`http://${context.devServer.host}:${context.devServer.port}`);
	baseUrl.pathname = context.devServer.startPath ?? '';

	const location = baseUrl.toString();
	const relDocumentRoot =
		'.' + path.sep + path.relative(process.cwd(), context.dir.input);

	const proxyLines = context.devServer.proxy
		? Object.entries(context.devServer.proxy)
				.map(([prefix, rule]) => {
					const target = typeof rule === 'string' ? rule : rule.target;
					return `  ${c.blue('Proxy')}: ${prefix} → ${c.bold.gray(target)}`;
				})
				.join('\n')
		: '';

	process.stdout.write(`
  ${c.bold.greenBright('Kamado Dev Server: Ignition🔥')}

  ${c.blue('Location')}: ${c.bold(location)}
  ${c.blue('DocumentRoot')}: ${c.bold.gray(relDocumentRoot)}
${proxyLines ? `${proxyLines}\n` : ''}`);

	if (context.devServer.open) {
		await open(location);
	}
}
