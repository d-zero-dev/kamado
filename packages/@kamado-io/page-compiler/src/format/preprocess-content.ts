import type { PageCompilerOptions } from '../types.js';
import type { CompileFunction } from 'kamado/compiler';
import type { TransformContext } from 'kamado/config';

/**
 * Required context for preprocessContent hook
 */
export interface PreprocessContentContext {
	/**
	 * Transform context to pass to the hook
	 */
	readonly transformContext: TransformContext;
	/**
	 * Compile function to pass to the hook
	 */
	readonly compile: CompileFunction;
}

/**
 * Options for preprocessContent hook
 */
export interface PreprocessContentOptions {
	/**
	 * Hook function called for preprocessing content before DOM parsing
	 */
	readonly preprocessContent?: PageCompilerOptions['preprocessContent'];
	/**
	 * Whether running on development server
	 * @default false
	 */
	readonly isServe?: boolean;
}

/**
 * Applies the preprocessContent hook to HTML content.
 *
 * Executes the user-provided hook function before DOM parsing occurs.
 * The hook receives the content, isServe flag, transform context, and compile function.
 * @param context - Required context (transformContext, compile)
 * @param options - Configuration options
 * @returns A function that takes content and returns a Promise of processed content
 * @internal
 */
export function preprocessContent(
	context: PreprocessContentContext,
	options?: PreprocessContentOptions,
): (content: string | ArrayBuffer) => Promise<string | ArrayBuffer> {
	return async (content: string | ArrayBuffer): Promise<string | ArrayBuffer> => {
		if (typeof content !== 'string') {
			return content;
		}

		const { transformContext, compile } = context;
		const { preprocessContent, isServe = false } = options ?? {};

		if (!preprocessContent) {
			return content;
		}

		return await preprocessContent(content, isServe, transformContext, compile);
	};
}
