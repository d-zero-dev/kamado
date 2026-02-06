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
 * Creates a transform for Prettier formatting
 * @param options - Prettier options
 * @returns Transform object
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

			return await prettierFormat(content, {
				parser: 'html',
				printWidth: 100_000,
				tabWidth: 2,
				useTabs: false,
				...prettierConfig,
				...options?.options,
			});
		},
	};
}
