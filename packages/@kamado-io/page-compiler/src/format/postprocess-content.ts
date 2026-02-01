import type { PageCompilerOptions } from '../types.js';

import path from 'node:path';

/**
 * Required context for content postprocessing
 */
export interface PostprocessContentContext {
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
 * Options for content postprocessing
 */
export interface PostprocessContentOptions {
	/**
	 * Hook function called for postprocessing content after DOM serialization
	 */
	readonly postprocessContent?: PageCompilerOptions['postprocessContent'];
	/**
	 * Whether running on development server
	 * @default false
	 */
	readonly isServe?: boolean;
}

/**
 * Applies final content postprocessing.
 *
 * Calculates path information and passes it to the postprocessContent callback function.
 * This is the last processing step in the pipeline.
 * @param context - Required context (outputPath, outputDir)
 * @param options - Configuration options
 * @returns A function that takes content and returns a Promise of processed content
 * @internal
 */
export function postprocessContent(
	context: PostprocessContentContext,
	options?: PostprocessContentOptions,
): (content: string | ArrayBuffer) => Promise<string | ArrayBuffer> {
	return async (content: string | ArrayBuffer): Promise<string | ArrayBuffer> => {
		if (typeof content !== 'string') {
			return content;
		}

		const { outputPath, outputDir } = context;
		const { postprocessContent: postprocessOption, isServe = false } = options ?? {};

		if (!postprocessOption) {
			return content;
		}

		const filePath = outputPath;
		const dirPath = path.dirname(filePath);
		const relativePathFromBase = path.relative(dirPath, outputDir) || '.';

		return await postprocessOption(
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
