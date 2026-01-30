import type { Context } from '../config/types.js';
import type { Hono } from 'hono';

import fs from 'node:fs/promises';
import path from 'node:path';

import { Lanes } from '@d-zero/dealer';
import { urlToLocalPath } from '@d-zero/shared/url-to-local-path';
import c from 'ansi-colors';

import { createCompiler } from '../compiler/create-compiler.js';
import { createCompileFunctionMap } from '../compiler/function-map.js';
import { getCompilableFileMap } from '../data/map.js';
import { filePathColorizer } from '../stdout/color.js';

import { applyTransforms } from './transform.js';

/**
 * Required context for setting routes
 */
export interface SetRouteContext {
	readonly app: Hono;
	readonly context: Context;
}

/**
 * Optional options for setting routes
 */
export interface SetRouteOptions {
	readonly verbose?: boolean;
}

const CHECK_MARK = c.green('✔');
const ERROR_MARK = c.red('✘');

/**
 * Sets routes for the application
 * @param context - Required context (app, context)
 * @param options - Optional options (verbose)
 * @returns Application after route configuration
 */
export async function setRoute(context: SetRouteContext, options?: SetRouteOptions) {
	const { app, context: kamadoContext } = context;
	const hostname =
		kamadoContext.devServer.host +
		(kamadoContext.devServer.port ? `:${kamadoContext.devServer.port}` : '');

	const compilableFileMap = await getCompilableFileMap(kamadoContext);
	const compileFunctionMap = await createCompileFunctionMap(kamadoContext);
	const compile = createCompiler({ ...kamadoContext, compileFunctionMap });

	const INDENT = '  ';

	const lanes = new Lanes({
		indent: INDENT.repeat(2),
	});
	const fileIds = new Map<string, number>();

	let fileIdIterator = 0;

	const f = filePathColorizer({ rootDir: kamadoContext.dir.input });

	const routes = app.get('*', async (ctx) => {
		const url = new URL(ctx.req.url, `http://${hostname}`);
		const requestFilePath = urlToLocalPath(url.toString(), '.html');

		const refLocalFilePath = path.resolve(kamadoContext.dir.output, requestFilePath);
		let fileId = fileIds.get(refLocalFilePath) ?? fileIdIterator++;

		// Helper to apply transforms and return response
		const respondWithTransform = async (
			content: string | ArrayBuffer,
			outputPath: string,
			inputPath?: string,
		) => {
			const transformed = await applyTransforms(
				{
					content,
					transformContext: {
						path: requestFilePath,
						inputPath,
						outputPath,
						isServe: true,
						context: kamadoContext,
					},
				},
				{ transforms: kamadoContext.devServer.transforms },
			);
			return ctx.body(transformed);
		};

		const ext = path.extname(requestFilePath).toLowerCase();
		switch (ext) {
			case '.html': {
				if (!ctx.req.header('x-requested-with')?.includes('XMLHttpRequest')) {
					lanes.clear({ header: true });
					lanes.header(
						`${INDENT}${c.bold('Load')}: ${url.toString()}\n${INDENT}${c.bold('Compile')}:`,
					);
				}
				ctx.header('Content-Type', 'text/html');
				break;
			}
			case '.css': {
				fileId *= 100;
				ctx.header('Content-Type', 'text/css');
				break;
			}
			case '.js': {
				fileId *= 10_000;
				ctx.header('Content-Type', 'text/javascript');
				break;
			}
			case '.json': {
				fileId *= 1_000_000;
				ctx.header('Content-Type', 'application/json');
				break;
			}
			case '.xml': {
				fileId *= 1_000_000_000;
				ctx.header('Content-Type', 'application/xml');
				break;
			}
			case '.svg': {
				fileId *= 1_000_000_000_000;
				ctx.header('Content-Type', 'image/svg+xml');
				break;
			}
		}

		fileIds.set(refLocalFilePath, fileId);

		const originalFile = compilableFileMap.get(refLocalFilePath);

		if (originalFile) {
			const fileName = f(originalFile.inputPath);

			lanes.update(fileId, `%braille% ${fileName}`);

			const content = await Promise.resolve(
				compile(
					{
						inputPath: originalFile.inputPath,
						outputExtension: ext,
					},
					options?.verbose
						? (message) => lanes.update(fileId, `%braille% ${fileName} ${message}`)
						: undefined,
					// Refresh the file content on each request
					false,
				),
			).catch((error: unknown) => {
				if (error instanceof Error) {
					return error;
				}
				throw error;
			});

			if (content instanceof Error) {
				lanes.update(fileId, `${ERROR_MARK} ${fileName} ${c.red(content.name)}`);
				return ctx.text(content.message, 500);
			}

			lanes.update(fileId, `${CHECK_MARK} ${fileName}`);

			if (content) {
				return respondWithTransform(
					content,
					originalFile.outputPath,
					originalFile.inputPath,
				);
			}
		}

		// If not found in the map, simply return the file contents

		const buf = await readFile(refLocalFilePath).catch(() => null);

		if (!buf) {
			return ctx.notFound();
		}

		return respondWithTransform(buf, refLocalFilePath);
	});

	return routes;
}

/**
 * Reads a file and returns its ArrayBuffer
 * @param filePath - Path to the file to read
 * @returns ArrayBuffer of the file content, or null if file cannot be read
 */
async function readFile(filePath: string) {
	const buffer = await fs.readFile(filePath).catch(() => null);
	if (!buffer) {
		return null;
	}
	if (buffer.buffer instanceof ArrayBuffer) {
		return buffer.buffer;
	}
	return null;
}

/**
 * Return type of setRoute function
 */
export type AppType = ReturnType<typeof setRoute>;
