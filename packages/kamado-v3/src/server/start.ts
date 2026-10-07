import type { RequestLog, ServeDescription } from './app.js';

import { spawn } from 'node:child_process';
import path from 'node:path';
import { styleText } from 'node:util';

import { serve } from '@hono/node-server';

import { native } from '../native.js';
import { RUNTIME_URL } from '../runtime-url.js';
import { ESBUILD_VERSION, findEsbuildBinary } from '../scripts.js';

import { createApp } from './app.js';

/** Options of {@link start}. */
export interface StartOptions {
	/** Log every request, files included. */
	readonly verbose?: boolean;
	/** Cache directory override. */
	readonly cacheDir?: string;
	/** Where lines of the log go (default: stdout). */
	readonly write?: (text: string) => void;
}

/** A running dev server. */
export interface RunningServer {
	/** Where it listens, with the start path. */
	readonly location: string;
	/** Stops the server and releases the renderer. */
	readonly close: () => Promise<void>;
}

/**
 * Opens the page in the default browser. The command differs by platform; a
 * failure to open is not a failure of the server.
 * @param location - The URL
 */
function openBrowser(location: string): void {
	const [command, args]: [string, string[]] =
		process.platform === 'darwin'
			? ['open', [location]]
			: process.platform === 'win32'
				? ['cmd', ['/c', 'start', '', location]]
				: ['xdg-open', [location]];
	const child = spawn(command, args, { detached: true, stdio: 'ignore' });
	child.on('error', () => {});
	child.unref();
}

/**
 * One line of the log for a request.
 * @param log - What the request ended as
 */
function formatRequest(log: RequestLog): string {
	const mark =
		log.status >= 500
			? styleText('red', '✘')
			: log.status >= 400
				? styleText('yellow', '!')
				: styleText('green', '✔');
	const tail = log.error === undefined ? '' : `\n${styleText('red', log.error)}`;
	return `  ${mark} ${log.pathname} ${styleText('dim', `${log.kind} ${log.ms}ms`)}${tail}`;
}

/**
 * Starts the development server for the project of `configPath`.
 *
 * Nothing is watched and nothing is written: every request checks the files
 * its answer was built from and builds it again only when one changed.
 * @param configPath - Absolute path of `kamado.config.jsonc`
 * @param options - Logging and cache options
 * @returns Resolves when the server listens
 * @throws {Error} when the config is invalid or the port cannot be used
 * @example
 * ```ts
 * const server = await start('/site/kamado.config.jsonc');
 * // ... later
 * await server.close();
 * ```
 */
export async function start(
	configPath: string,
	options: StartOptions = {},
): Promise<RunningServer> {
	const write = options.write ?? ((text: string) => process.stdout.write(text));
	const core = native();
	const description = JSON.parse(
		core.serveOpen(
			configPath,
			JSON.stringify({
				serving: true,
				tzOffsetMinutes: 0 - new Date().getTimezoneOffset(),
				esbuildVersion: ESBUILD_VERSION,
				esbuildBinary: findEsbuildBinary(),
				...(options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir }),
			}),
			RUNTIME_URL,
		),
	) as ServeDescription;
	const { host, port, startPath, proxy } = description.devServer;

	const { app, close } = createApp(description, RUNTIME_URL, {
		onRequest: (log) => {
			if (options.verbose === true || log.kind !== 'file' || log.status >= 400) {
				write(formatRequest(log) + '\n');
			}
		},
	});

	const server = serve({ fetch: app.fetch, hostname: host, port });
	await new Promise<void>((resolve, reject) => {
		const onError = (error: NodeJS.ErrnoException) => {
			void close();
			reject(
				error.code === 'EADDRINUSE'
					? new Error(`port ${port} is already in use (devServer.port)`, { cause: error })
					: error,
			);
		};
		server.once('listening', () => {
			server.off('error', onError);
			resolve();
		});
		server.once('error', onError);
	});

	const location = new URL(startPath, `http://${host}:${port}`).toString();
	const relRoot = '.' + path.sep + path.relative(process.cwd(), description.inputDir);
	const proxyLines = Object.entries(proxy)
		.map(([prefix, rule]) => {
			const target = typeof rule === 'string' ? rule : rule.target;
			return `  ${styleText('blue', 'Proxy')}: ${prefix} → ${styleText(['bold', 'gray'], target)}`;
		})
		.join('\n');
	write(
		`\n  ${styleText(['bold', 'greenBright'], 'Kamado Dev Server: Ignition🔥')}\n\n` +
			`  ${styleText('blue', 'Location')}: ${styleText('bold', location)}\n` +
			`  ${styleText('blue', 'DocumentRoot')}: ${styleText(['bold', 'gray'], relRoot)}\n` +
			(proxyLines ? `${proxyLines}\n` : '') +
			'\n',
	);

	const shutdown = () => {
		server.close(() => {
			void close().finally(() => process.exit(0));
		});
	};
	process.once('SIGINT', shutdown);
	process.once('SIGTERM', shutdown);

	if (description.devServer.open) {
		openBrowser(location);
	}

	return {
		location,
		close: async () => {
			process.off('SIGINT', shutdown);
			process.off('SIGTERM', shutdown);
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
			await close();
		},
	};
}
