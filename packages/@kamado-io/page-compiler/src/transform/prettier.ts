import type { Transform } from 'kamado/config';
import type { MetaData } from 'kamado/files';

import {
	format as prettierFormat,
	resolveConfig as prettierResolveConfig,
	type Options as PrettierFormatOptions,
} from 'prettier';

/**
 * Behavior when Prettier fails to parse the input.
 * - `silent` (default): swallow the error and return the unformatted source
 * - `warning`: console.warn with the source path, then return the unformatted source
 * - `error`: throw an Error prefixed with the source path
 */
export type PrettierParseErrorMode = 'silent' | 'warning' | 'error';

/**
 * Options for prettier
 */
export interface PrettierOptions {
	readonly options?: PrettierFormatOptions;
	/**
	 * How to handle Prettier parse failures. Defaults to `'silent'`.
	 */
	readonly parseError?: PrettierParseErrorMode;
}

/**
 * Creates a transform for Prettier formatting.
 *
 * When Prettier fails (typically a parser error on malformed HTML), the
 * `parseError` option determines the behavior:
 *
 * - `'silent'` (default) — the unformatted source is returned as-is
 * - `'warning'` — `console.warn` is invoked with a message prefixed with the
 *   source file path (`ctx.inputPath`, falling back to `ctx.outputPath`), and
 *   the unformatted source is returned
 * - `'error'` — an `Error` prefixed with the source file path is thrown; the
 *   underlying Prettier error is preserved on `error.cause` so downstream
 *   handlers can inspect details such as `loc`
 * @template M - Metadata (frontmatter) type for pages handled by this transform
 * @param options - Prettier options
 * @returns Transform object
 * @throws Error - Only when `parseError` is `'error'` and Prettier fails to
 * format the input. The message identifies the source file; the underlying
 * Prettier error is available via `error.cause`.
 */
export function prettier<M extends MetaData>(options?: PrettierOptions): Transform<M> {
	return {
		name: 'prettier',
		transform: async (content, ctx) => {
			if (typeof content !== 'string') {
				const decoder = new TextDecoder('utf-8');
				content = decoder.decode(content);
			}

			const prettierConfig = ctx.inputPath
				? await prettierResolveConfig(ctx.inputPath)
				: null;

			try {
				return await prettierFormat(content, {
					parser: 'html',
					printWidth: 100_000,
					tabWidth: 2,
					useTabs: false,
					...prettierConfig,
					...options?.options,
				});
			} catch (error) {
				const source = ctx.inputPath ?? ctx.outputPath;
				const original = error instanceof Error ? error.message : String(error);
				const message = `Prettier failed to format ${source}: ${original}`;
				const mode: PrettierParseErrorMode = options?.parseError ?? 'silent';

				if (mode === 'error') {
					throw new Error(message, { cause: error });
				}
				if (mode === 'warning') {
					// eslint-disable-next-line no-console
					console.warn(message);
				}
				return content;
			}
		},
	};
}
