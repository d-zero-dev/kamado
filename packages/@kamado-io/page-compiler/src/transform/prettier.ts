import type { Transform } from 'kamado/config';
import type { MetaData } from 'kamado/files';

import {
	format as prettierFormat,
	resolveConfig as prettierResolveConfig,
	type Options as PrettierFormatOptions,
} from 'prettier';

/**
 * Options for prettier
 */
export interface PrettierOptions {
	readonly options?: PrettierFormatOptions;
}

/**
 * Creates a transform for Prettier formatting.
 *
 * When Prettier fails (typically a parser error on malformed HTML), the original
 * error is re-thrown wrapped in an `Error` whose message is prefixed with the
 * source file path (`ctx.inputPath`, falling back to `ctx.outputPath`). The
 * original Prettier error is preserved on the wrapped error's `cause` property
 * so downstream handlers can inspect details such as `loc`.
 * @template M - Metadata (frontmatter) type for pages handled by this transform
 * @param options - Prettier options
 * @returns Transform object
 * @throws Error - When Prettier fails to format the input. The message identifies
 * the source file; the underlying Prettier error is available via `error.cause`.
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
				const wrapped = new Error(`Prettier failed to format ${source}: ${original}`, {
					cause: error,
				});
				throw wrapped;
			}
		},
	};
}
