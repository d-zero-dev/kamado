/**
 * The HTTP side of `kamado ui` (RFC section 14.2). The core edits the files; this module is
 * the door the browser comes in by: the page of the screen (`GET /`), its files
 * (`GET /assets/<name>`), four calls (`GET /api/pages`, `GET /api/values`,
 * `POST /api/refresh`, `POST /api/edit`) that pass JSON to the editor of the core and its
 * answer back, the branch and commit of the site's repository (`GET /api/git`, see
 * `git.ts`), and the settings the screen keeps between runs (`GET` and `PUT /api/settings`,
 * see `settings.ts`).
 *
 * Why a token for every call that is not a GET: the screen writes the source files of the
 * project, and a page of another site can make a browser send a request to `localhost`. The
 * guard of the dev server refuses requests the browser marks as cross-site, but it is not
 * the only line: a request that arrives without those marks (a tool, a `fetch` with `no-cors`
 * from an old browser) must still not write. The token is made at each start, placed in the
 * page of the screen (a page of another site cannot read it) and sent back in a header.
 *
 * Why only the loopback: there is no `--host`. What is edited is the source of the site.
 */
import type { GitInfo } from './git.js';
import type { Roots } from './paths.js';
import type { native } from '../native.js';
import type { Hono as HonoApp } from 'hono';

import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { etag } from 'hono/etag';

import { setGuard } from '../server/guard.js';
import { contentTypeOf } from '../server/mime.js';

import { scrub, showPaths } from './paths.js';
import { isSortKey, parsePatch, SettingsError, type SettingsStore } from './settings.js';

/** The header the token goes in. */
export const TOKEN_HEADER = 'X-Kamado-Token';

/** The most rows a request may ask for (RFC section 14.2: the screen shows 5,000 at most). */
export const MAX_ROWS = 5000;

/**
 * The most values `GET /api/values` may be asked for: the most the options of a column may be
 * (200) with room to spare, so that the answer is never cut below what the screen keeps. Not
 * lower than that, and not unbounded: the answer is one JSON, and a key every page holds
 * differently (a title) has as many values as there are pages.
 */
export const MAX_VALUES = 1000;

/** The largest body of an edit, in bytes. A value of a page's metadata is far smaller. */
const MAX_BODY = 1024 * 1024;

/**
 * The largest body of a change of the settings: they are a few fields. The largest of them is
 * the layout of the columns, whose limit (`MAX_COLUMNS` of `settings.ts`) is set to fit in this.
 */
const MAX_SETTINGS_BODY = 64 * 1024;

/** Where the page of the screen has the token (replaced when the page is served). */
export const TOKEN_PLACEHOLDER = '__KAMADO_TOKEN__';

/** Options of {@link createUiApp}. */
export interface UiAppOptions {
	/** The directory of the built screen (`index.html` and `assets/`). */
	readonly uiDir: string;
	/** The token the writes must carry. */
	readonly token: string;
	/** The directories the paths shown are told from; no absolute path goes to the screen. */
	readonly roots: Roots;
	/**
	 * What the screen remembers between runs (`GET`/`PUT /api/settings`). Without it the
	 * routes do not exist.
	 */
	readonly settings?: SettingsStore;
	/**
	 * Reads the branch and the commit of the site's repository (`GET /api/git`), asked for at each
	 * request: the branch can be switched while the screen is open (the reader may remember an
	 * answer for a moment, see `cachedReadGit`). Without it the answer is `null`.
	 */
	readonly git?: () => Promise<GitInfo | null>;
}

/** A row, as far as this module reads it. */
type Page = { readonly inputPath: string | null; readonly outputPath: string };

/**
 * What the app needs of the editor of the core (see `Native`).
 */
export type Editor = Pick<
	ReturnType<typeof native>,
	'uiPages' | 'uiRefresh' | 'uiEdit' | 'uiValues'
> & {
	/** The handle of the editor. */
	readonly handle: string;
};

/**
 * The status of the answer to an edit the core refused, by its code.
 * @param code - `code` of the answer
 */
function statusOf(code: string): 400 | 404 | 409 | 500 {
	switch (code) {
		case 'conflict':
		case 'collision': {
			return 409;
		}
		case 'notFound': {
			return 404;
		}
		case 'io': {
			return 500;
		}
		default: {
			return 400;
		}
	}
}

/**
 * Whether two strings are equal, in a time that does not depend on where they differ.
 * @param given - What the request carried
 * @param expected - The token
 */
function sameToken(given: string | undefined, expected: string): boolean {
	if (given === undefined) {
		return false;
	}
	// Hashed first: `timingSafeEqual` needs equal lengths, and the length of the token is
	// not a secret worth a branch.
	const a = createHash('sha256').update(given).digest();
	const b = createHash('sha256').update(expected).digest();
	return timingSafeEqual(a, b);
}

/**
 * Reads a non-negative integer from a query parameter.
 * @param value - The parameter, or `undefined`
 * @param fallback - What an absent parameter is
 * @returns The integer, or `null` when it is not one
 */
function integerOf(value: string | undefined, fallback: number): number | null {
	if (value === undefined) {
		return fallback;
	}
	return /^\d{1,9}$/.test(value) ? Number(value) : null;
}

/**
 * Reads the sort of a request. The column is named by its identifier: `url`, `inputPath`,
 * `virtual`, or `meta:<key>` (RFC section 14.2). The core takes the same four and says no to
 * anything else; this says it at the door with a `400` and keeps a long key out of the call.
 * @param key - The `sort` parameter
 * @param desc - The `desc` parameter (`true` or `false`)
 * @returns `undefined` when there is no sort (neither parameter is given, or `sort` is empty
 * and `desc` is not given), `null` when the parameters are not a sort (a column that is not
 * one, a `desc` that is not `true` or `false`, or a `desc` with no column)
 * @example
 * ```ts
 * sortFromQuery('meta:title', 'true'); // { key: 'meta:title', desc: true }
 * sortFromQuery(undefined, undefined); // undefined
 * sortFromQuery('title', undefined); // null
 * ```
 */
function sortFromQuery(
	key: string | undefined,
	desc: string | undefined,
): { key: string; desc: boolean } | null | undefined {
	if (desc !== undefined && desc !== 'true' && desc !== 'false') {
		return null;
	}
	if (key === undefined || key === '') {
		// A direction without a column is not a sort.
		return desc === undefined ? undefined : null;
	}
	return isSortKey(key) ? { key, desc: desc === 'true' } : null;
}

/**
 * Makes the app of `kamado ui`.
 * @param editor - The editor of the core
 * @param options - The directory of the screen, the token, and the directories the paths
 * are told from
 * @returns The Hono app
 * @example
 * ```ts
 * const app = createUiApp(
 * 	{ handle: 'h1', ...native() },
 * 	{
 * 		uiDir: '/pkg/dist/ui',
 * 		token: 'a-long-random-string',
 * 		roots: { rootDir: '/site', inputDir: '/site/src', outputDir: '/site/htdocs' },
 * 	},
 * );
 * const response = await app.request('/api/pages?limit=100', {
 * 	headers: { Host: 'localhost' },
 * });
 * ```
 */
export function createUiApp(editor: Editor, options: UiAppOptions): HonoApp {
	const app = new Hono();
	const { roots } = options;
	// The site's `allowedHosts` are not carried over: the editor answers on the loopback
	// names only, whatever the dev server of the site is told to serve.
	setGuard(app, { host: 'localhost', allowedHosts: [], proxy: {} });

	app.use('*', async (ctx, next) => {
		await next();
		// Every answer: what is shown is the source of the project.
		// The page and the answers hold the source of the project: kept out of every cache. The
		// bundle and the style sheet hold nothing of it, but their names do not change with
		// their content, so they are kept and asked about each time (`ETag`, below): a build of
		// the screen is shown at the next load, and the bundle is not downloaded again.
		ctx.header(
			'Cache-Control',
			ctx.req.path.startsWith('/assets/') ? 'no-cache' : 'no-store',
		);
		ctx.header('Referrer-Policy', 'no-referrer');
		ctx.header('X-Content-Type-Options', 'nosniff');
		ctx.header('Cross-Origin-Resource-Policy', 'same-origin');
	});

	app.use('*', async (ctx, next) => {
		if (ctx.req.method === 'GET' || ctx.req.method === 'HEAD') {
			return next();
		}
		if (!sameToken(ctx.req.header(TOKEN_HEADER), options.token)) {
			return ctx.json(
				{ error: 'forbidden', message: 'the token is missing or wrong' },
				403,
			);
		}
		if (
			(ctx.req.method === 'POST' || ctx.req.method === 'PUT') &&
			ctx.req.header('content-type')?.split(';')[0]?.trim() !== 'application/json'
		) {
			return ctx.json(
				{ error: 'unsupported', message: 'the body must be application/json' },
				415,
			);
		}
		return next();
	});

	app.get('/', async (ctx) => {
		let html: string;
		try {
			html = await readFile(path.join(options.uiDir, 'index.html'), 'utf8');
		} catch {
			return ctx.text('The screen of kamado ui is not built (yarn build).', 500);
		}
		ctx.header(
			'Content-Security-Policy',
			"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
		);
		return ctx.html(html.replaceAll(TOKEN_PLACEHOLDER, options.token));
	});

	app.use('/assets/*', etag());

	app.get('/assets/:name', async (ctx) => {
		const name = ctx.req.param('name');
		// One file name: no separator, no way up.
		if (name !== path.basename(name) || name.startsWith('.')) {
			return ctx.text('Not Found', 404);
		}
		const file = path.join(options.uiDir, 'assets', name);
		try {
			const info = await stat(file);
			if (!info.isFile()) {
				return ctx.text('Not Found', 404);
			}
			const body = await readFile(file);
			return new Response(new Uint8Array(body), {
				headers: { 'Content-Type': contentTypeOf(file) },
			});
		} catch {
			return ctx.text('Not Found', 404);
		}
	});

	app.get('/api/pages', (ctx) => {
		const offset = integerOf(ctx.req.query('offset'), 0);
		const limit = integerOf(ctx.req.query('limit'), 100);
		if (offset === null || limit === null || limit < 1 || limit > MAX_ROWS) {
			return ctx.json(
				{
					error: 'invalid',
					message: `offset is a number, and limit is a number from 1 to ${MAX_ROWS}`,
				},
				400,
			);
		}
		const q = ctx.req.query('q');
		const sort = sortFromQuery(ctx.req.query('sort'), ctx.req.query('desc'));
		if (sort === null) {
			return ctx.json(
				{
					// Told apart from `invalid` (a bad offset or limit): the screen lets go of a
					// sort that is refused, and must not do so for any other refusal.
					error: 'invalidSort',
					message:
						'sort is url, inputPath, virtual or meta:<key>, and desc is true or false',
				},
				400,
			);
		}
		return answer(
			ctx,
			() => {
				const rows = JSON.parse(
					editor.uiPages(
						editor.handle,
						JSON.stringify({
							offset,
							limit,
							...(q === undefined || q === '' ? {} : { q }),
							...(sort === undefined ? {} : { sort }),
						}),
					),
				) as { pages: Page[]; warnings: string[] };
				return {
					...rows,
					pages: rows.pages.map((page) => showPaths(page, roots)),
					warnings: rows.warnings.map((warning) => scrub(warning, roots)),
				};
			},
			roots,
		);
	});

	app.get('/api/git', async (ctx) => {
		// Not a failure of the editor when it cannot be told: the header just shows nothing.
		let info: GitInfo | null = null;
		try {
			info = (await options.git?.()) ?? null;
		} catch {
			info = null;
		}
		return ctx.json(info);
	});

	app.get('/api/values', (ctx) => {
		const key = ctx.req.query('key');
		const limit = integerOf(ctx.req.query('limit'), 100);
		// Only a key of the metadata has values, so only `meta:<key>` is a key here, and its length
		// is limited as the settings limit a column's name (an enum is kept there). The core takes a
		// limit of 0; the server does not, as a request for no value is not one the screen makes.
		if (
			key === undefined ||
			!key.startsWith('meta:') ||
			!isSortKey(key) ||
			limit === null ||
			limit < 1 ||
			limit > MAX_VALUES
		) {
			return ctx.json(
				{
					error: 'invalid',
					message: `key is meta:<key>, and limit is a number from 1 to ${MAX_VALUES}`,
				},
				400,
			);
		}
		return answer(
			ctx,
			() =>
				JSON.parse(
					editor.uiValues(editor.handle, JSON.stringify({ key, limit })),
				) as unknown,
			roots,
		);
	});

	app.post('/api/refresh', (ctx) =>
		answer(ctx, () => JSON.parse(editor.uiRefresh(editor.handle)) as unknown, roots),
	);

	app.post(
		'/api/edit',
		bodyLimit({
			maxSize: MAX_BODY,
			onError: (ctx) =>
				ctx.json({ error: 'invalid', message: 'the body is too large' }, 413),
		}),
		async (ctx) => {
			let request: unknown;
			try {
				request = await ctx.req.json();
			} catch {
				return ctx.json({ error: 'invalid', message: 'the body is not JSON' }, 400);
			}
			if (!isEditRequest(request)) {
				return ctx.json(
					{ error: 'invalid', message: 'the body is not { url, expect, change }' },
					400,
				);
			}
			let result: {
				ok: boolean;
				code?: string;
				message?: string;
				page?: Page;
				current?: Page;
			};
			try {
				result = JSON.parse(
					editor.uiEdit(editor.handle, JSON.stringify(request)),
				) as typeof result;
			} catch (error) {
				return ctx.json(
					{
						error: 'failed',
						message: scrub(error instanceof Error ? error.message : String(error), roots),
					},
					500,
				);
			}
			if (result.ok) {
				return ctx.json({
					...result,
					...(result.page === undefined ? {} : { page: showPaths(result.page, roots) }),
				});
			}
			const code = result.code ?? 'failed';
			return ctx.json(
				{
					error: code,
					message: scrub(result.message ?? '', roots),
					...(result.current === undefined
						? {}
						: { current: showPaths(result.current, roots) }),
				},
				statusOf(code),
			);
		},
	);

	const { settings } = options;
	if (settings !== undefined) {
		app.get('/api/settings', async (ctx) => ctx.json(await settings.view()));

		app.put(
			'/api/settings',
			bodyLimit({
				maxSize: MAX_SETTINGS_BODY,
				onError: (ctx) =>
					ctx.json({ error: 'invalid', message: 'the body is too large' }, 413),
			}),
			async (ctx) => {
				let patch;
				try {
					patch = parsePatch(await ctx.req.json());
				} catch (error) {
					return ctx.json(
						{
							error: 'invalid',
							message:
								error instanceof SyntaxError
									? 'the body is not JSON'
									: error instanceof Error
										? error.message
										: String(error),
						},
						400,
					);
				}
				try {
					return ctx.json(await settings.update(patch));
				} catch (error) {
					if (error instanceof SettingsError) {
						return ctx.json(
							{ error: error.code, message: error.message },
							error.code === 'newer' ? 409 : 503,
						);
					}
					// What the disk says names the path of the file: only its code is passed on.
					const code = (error as NodeJS.ErrnoException).code;
					return ctx.json(
						{
							error: 'failed',
							message: `the settings could not be saved${code === undefined ? '' : ` (${code})`}`,
						},
						500,
					);
				}
			},
		);
	}

	app.notFound((ctx) => ctx.json({ error: 'not-found', message: 'no such route' }, 404));
	return app;
}

/**
 * Whether a parsed body has the parts of an edit request: the shape of the three, not what
 * is in them (the core checks that, and says why).
 * @param value - The parsed body
 */
function isEditRequest(value: unknown): boolean {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const { url, expect, change } = value as Record<string, unknown>;
	return (
		typeof url === 'string' &&
		typeof expect === 'object' &&
		expect !== null &&
		!Array.isArray(expect) &&
		typeof change === 'object' &&
		change !== null &&
		!Array.isArray(change)
	);
}

/**
 * Sends what `run` made as JSON; an error of the core is a 500 with its message (told
 * without the directories of the machine).
 * @param ctx - The context
 * @param ctx.json - Makes the JSON response (the 500 of an error)
 * @param run - Calls the core
 * @param roots - The directories the paths are told from
 */
function answer(
	ctx: {
		json: (data: unknown, status?: 500) => Response;
	},
	run: () => unknown,
	roots: Roots,
): Response {
	try {
		return ctx.json(run());
	} catch (error) {
		return ctx.json(
			{
				error: 'failed',
				message: scrub(error instanceof Error ? error.message : String(error), roots),
			},
			500,
		);
	}
}
