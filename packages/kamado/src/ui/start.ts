import type { ServerType } from '@hono/node-server';

import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { styleText } from 'node:util';

import { createAdaptorServer } from '@hono/node-server';

import { native } from '../native.js';
import { close as closeServer, listen, listenAddresses } from '../server/listen.js';
import { openBrowser } from '../server/start.js';

import { createUiApp } from './app.js';
import { createSettingsStore, defaultSettingsFile } from './settings.js';

/** Options of {@link ui}. */
export interface UiOptions {
	/**
	 * The port to listen on, 0 to 65535 (`0` takes a free port, for a program that reads it
	 * from `url`; the command line takes 1 to 65535). The default is the port of `devServer`,
	 * plus one.
	 */
	readonly port?: number;
	/** Open the screen in the default browser. The default is `devServer.open`. */
	readonly open?: boolean;
	/** The cache directory (the same as `build`'s `cacheDir`). */
	readonly cacheDir?: string;
	/** Where lines of the log go (default: stdout). */
	readonly write?: (text: string) => void;
	/**
	 * The directory of the built screen (`index.html` and `assets/`). The default is
	 * `dist/ui` of the package; a program has no reason to set it.
	 */
	readonly uiDir?: string;
	/**
	 * The file the screen keeps its settings in (RFC section 14.2). The default is
	 * `~/.config/kamado/ui-settings.json` (or the file `KAMADO_UI_SETTINGS` names); a program
	 * has little reason to set it.
	 */
	readonly settingsFile?: string;
}

/** A running editor. */
export interface RunningUi {
	/** Where it listens (the address of the screen). */
	readonly url: string;
	/** Stops the server and lets the editor of the core go, writing the plan cache. */
	readonly close: () => Promise<void>;
}

/**
 * The directory of the built screen: `dist/ui`, the one this module (`dist/ui/start.js`) is in.
 * The screen is bundled into `index.html` and `assets/` there, next to the compiled server code.
 */
const UI_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Starts the editor of the pages of the project of `configPath` (RFC section 14.2): plans the
 * site, listens on the loopback, and serves the screen.
 *
 * Nothing is rendered and the dev server is not started; a page that was edited shows in a
 * running `kamado server` when its browser is reloaded. The site is read when the editor
 * opens and when the screen asks to read it again (when it is opened again, after a move of a
 * URL, and by its button): files changed by other means appear then, and an edit of a file
 * that changed since it was read is refused rather than written over.
 *
 * On SIGINT and SIGTERM the server stops, the editor is released and the process exits
 * (`start()` of the dev server does the same). Unlike `start()`, a second signal while the
 * first is still waiting for connections to end releases the editor at once and exits with
 * 1, so that the plan cache is written even when a browser tab keeps its connection open.
 * @param configPath - Absolute path of `kamado.config.jsonc`
 * @param options - Port, browser and cache options
 * @returns Resolves when the server listens
 * @throws {Error} when the config is invalid, the site cannot be planned, or the port cannot
 * be used
 * @example
 * ```ts
 * const editor = await ui('/site/kamado.config.jsonc', { open: false });
 * console.log(editor.url); // http://localhost:3001/
 * await editor.close();
 * ```
 */
export async function ui(
	configPath: string,
	options: UiOptions = {},
): Promise<RunningUi> {
	const write = options.write ?? ((text: string) => process.stdout.write(text));
	const core = native();
	const handle = core.uiOpen(
		configPath,
		JSON.stringify(options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir }),
	);
	let released = false;
	const release = (): void => {
		if (released) {
			return;
		}
		released = true;
		const { warning } = JSON.parse(core.uiClose(handle)) as { warning: string | null };
		if (warning !== null) {
			write(`${warning}\n`);
		}
	};

	let servers: ServerType[];
	let url: string;
	let open: boolean;
	let wanted = options.port;
	try {
		const dev = JSON.parse(core.uiServer(handle)) as {
			port: number;
			open: boolean;
			inputDir: string;
			outputDir: string;
		};
		const port = options.port ?? dev.port + 1;
		wanted = port;
		if (!Number.isInteger(port) || port < 0 || port > 65_535) {
			throw new Error(
				options.port === undefined
					? `the port after devServer.port (${dev.port}) is out of range: give one with --port`
					: `port ${port} cannot be used (--port takes 1 to 65535)`,
			);
		}
		open = options.open ?? dev.open;
		// The project is told by the real path of its config file, as the command line finds it
		// (a link to the project would otherwise be another project).
		let project = configPath;
		try {
			project = realpathSync(configPath);
		} catch {
			// Not there: the editor of the core has failed already, so this is the path as given.
		}
		const settingsFile = options.settingsFile ?? defaultSettingsFile();
		const settings = createSettingsStore(settingsFile, project);
		const { warning: settingsWarning } = await settings.open();
		if (settingsWarning !== null) {
			// The terminal is the owner's: the file is named in full here, and by its name only
			// on the screen.
			write(`warning: ${settingsWarning} (${settingsFile})\n`);
		}
		const app = createUiApp(
			{
				handle,
				uiPages: (h, q) => core.uiPages(h, q),
				uiRefresh: (h) => core.uiRefresh(h),
				uiEdit: (h, e) => core.uiEdit(h, e),
			},
			{
				uiDir: options.uiDir ?? UI_DIR,
				token: randomBytes(32).toString('base64url'),
				settings,
				roots: {
					rootDir: path.dirname(configPath),
					inputDir: dev.inputDir,
					outputDir: dev.outputDir,
				},
			},
		);
		servers = await listen(
			() => createAdaptorServer({ fetch: app.fetch, hostname: 'localhost' }),
			listenAddresses('localhost'),
			port,
		);
		const bound = servers[0]?.address();
		const actual = typeof bound === 'object' && bound !== null ? bound.port : port;
		url = `http://localhost:${actual}/`;
	} catch (error) {
		release();
		const { code, address } = (error ?? {}) as NodeJS.ErrnoException & {
			address?: string;
		};
		const on = address === undefined ? '' : ` on ${address}`;
		throw code === 'EADDRINUSE'
			? new Error(`port ${wanted ?? '?'} is already in use${on} (--port)`, {
					cause: error,
				})
			: error;
	}

	const closeServers = () =>
		Promise.all(servers.map((server) => closeServer(server, true)));
	write(
		`\n  ${styleText(['bold', 'greenBright'], 'Kamado UI')}\n\n` +
			`  ${styleText('blue', 'Location')}: ${styleText('bold', url)}\n\n`,
	);

	let stopping = false;
	const shutdown = () => {
		if (stopping) {
			// A second signal: the first is waiting on connections that do not end. The
			// plan cache is still written before the process goes.
			release();
			process.exit(1);
		}
		stopping = true;
		void closeServers()
			.catch((error: unknown) => {
				write(`${error instanceof Error ? error.message : String(error)}\n`);
			})
			.then(() => {
				release();
				process.exit(0);
			});
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	if (open) {
		openBrowser(url);
	}

	return {
		url,
		close: async () => {
			process.off('SIGINT', shutdown);
			process.off('SIGTERM', shutdown);
			await closeServers();
			release();
		},
	};
}
