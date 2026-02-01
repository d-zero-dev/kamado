import type { PageCompilerOptions } from '../types.js';

import path from 'node:path';

/**
 * Required context for content replacement
 */
export interface ReplaceContext {
	/**
	 * Output file path
	 */
	readonly outputPath: string;
	/**
	 * Output directory path
	 */
	readonly outputDir: string;
}

/**
 * Options for content replacement
 */
export interface ReplaceOptions {
	/**
	 * Final HTML content replacement processing
	 */
	readonly replace?: PageCompilerOptions['replace'];
	/**
	 * Whether running on development server
	 * @default false
	 */
	readonly isServe?: boolean;
}

/**
 * Applies final content replacement processing.
 *
 * Calculates path information and passes it to the replace callback function.
 * This is the last processing step in the pipeline.
 * @param context - Required context (outputPath, outputDir)
 * @param options - Configuration options
 * @returns A function that takes content and returns a Promise of replaced content
 * @internal
 */
export function replace(
	context: ReplaceContext,
	options?: ReplaceOptions,
): (content: string | ArrayBuffer) => Promise<string | ArrayBuffer> {
	return async (content: string | ArrayBuffer): Promise<string | ArrayBuffer> => {
		if (typeof content !== 'string') {
			return content;
		}

		const { outputPath, outputDir } = context;
		const { replace: replaceOption, isServe = false } = options ?? {};

		if (!replaceOption) {
			return content;
		}

		const filePath = outputPath;
		const dirPath = path.dirname(filePath);
		const relativePathFromBase = path.relative(dirPath, outputDir) || '.';

		return await replaceOption(
			content,
			{
				filePath,
				dirPath,
				relativePathFromBase,
			},
			isServe,
		);
	};
}
