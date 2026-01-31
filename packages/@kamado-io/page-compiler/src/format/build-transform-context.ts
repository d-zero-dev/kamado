import type { Context, TransformContext } from 'kamado/config';

/**
 * Required context for building TransformContext
 */
export interface BuildTransformContextContext {
	/**
	 * Output file path
	 */
	readonly outputPath: string;
	/**
	 * Output directory path
	 */
	readonly outputDir: string;
	/**
	 * Input file path
	 */
	readonly inputPath: string;
	/**
	 * Kamado context
	 */
	readonly kamadoContext: Context;
}

/**
 * Options for building TransformContext
 */
export interface BuildTransformContextOptions {
	/**
	 * Whether running on development server
	 * @default false
	 */
	readonly isServe?: boolean;
}

/**
 * Builds a TransformContext object for transform hooks.
 *
 * Calculates the relative path from outputDir and falls back to '/' for root files.
 * @param context - Required context (outputPath, outputDir, inputPath, kamadoContext)
 * @param options - Optional options (isServe)
 * @returns TransformContext object
 * @internal
 */
export function buildTransformContext(
	context: BuildTransformContextContext,
	options?: BuildTransformContextOptions,
): TransformContext {
	const { outputPath, outputDir, inputPath, kamadoContext } = context;
	const { isServe = false } = options ?? {};

	// Calculate relative path from outputDir, falling back to '/' for root files
	const relativePath = outputPath.replace(outputDir, '').replace(/^\//, '') || '/';

	return {
		path: relativePath,
		inputPath,
		outputPath,
		isServe,
		context: kamadoContext,
	};
}
