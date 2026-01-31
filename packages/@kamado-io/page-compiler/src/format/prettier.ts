import type { PageCompilerOptions } from '../types.js';

import {
	format as prettierFormat,
	resolveConfig as prettierResolveConfig,
} from 'prettier';

/**
 * Required context for Prettier formatting
 */
export interface PrettierContext {
	/**
	 * Input file path (used to resolve Prettier config)
	 */
	readonly inputPath: string;
}

/**
 * Options for Prettier formatting
 */
export interface PrettierOptions {
	/**
	 * Prettier configuration options
	 * Set to false to disable Prettier formatting
	 * @default true
	 */
	readonly prettier?: PageCompilerOptions['prettier'];
}

/**
 * Formats HTML content using Prettier.
 *
 * Resolves Prettier configuration from the input file path and merges it with user options.
 * Uses sensible defaults optimized for HTML output.
 * @param context - Required context (inputPath)
 * @param options - Configuration options
 * @returns A function that takes content and returns a Promise of formatted content
 * @internal
 */
export function prettier(
	context: PrettierContext,
	options?: PrettierOptions,
): (content: string | ArrayBuffer) => Promise<string | ArrayBuffer> {
	return async (content: string | ArrayBuffer): Promise<string | ArrayBuffer> => {
		if (typeof content !== 'string') {
			return content;
		}

		const { inputPath } = context;
		const { prettier: prettierOption } = options ?? {};

		// Skip if explicitly disabled
		if (prettierOption === false) {
			return content;
		}

		const userPrettierConfig = typeof prettierOption === 'object' ? prettierOption : {};
		const prettierConfig = await prettierResolveConfig(inputPath);

		return await prettierFormat(content, {
			parser: 'html',
			printWidth: 100_000,
			tabWidth: 2,
			useTabs: false,
			...prettierConfig,
			...userPrettierConfig,
		});
	};
}
