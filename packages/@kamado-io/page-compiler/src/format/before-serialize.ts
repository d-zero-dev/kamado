import type { PageCompilerOptions } from '../types.js';
import type { CompileFunction } from 'kamado/compiler';
import type { TransformContext } from 'kamado/config';

/**
 * Required context for beforeSerialize hook
 */
export interface BeforeSerializeContext {
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
 * Options for beforeSerialize hook
 */
export interface BeforeSerializeOptions {
	/**
	 * Hook function called before DOM serialization
	 */
	readonly beforeSerialize?: PageCompilerOptions['beforeSerialize'];
	/**
	 * Whether running on development server
	 * @default false
	 */
	readonly isServe?: boolean;
}

/**
 * Applies the beforeSerialize hook to HTML content.
 *
 * Executes the user-provided hook function before DOM serialization occurs.
 * The hook receives the content, isServe flag, transform context, and compile function.
 * @param context - Required context (transformContext, compile)
 * @param options - Configuration options
 * @returns A function that takes content and returns a Promise of processed content
 * @internal
 */
export function beforeSerialize(
	context: BeforeSerializeContext,
	options?: BeforeSerializeOptions,
): (content: string | ArrayBuffer) => Promise<string | ArrayBuffer> {
	return async (content: string | ArrayBuffer): Promise<string | ArrayBuffer> => {
		if (typeof content !== 'string') {
			return content;
		}

		const { transformContext, compile } = context;
		const { beforeSerialize, isServe = false } = options ?? {};

		if (!beforeSerialize) {
			return content;
		}

		return await beforeSerialize(content, isServe, transformContext, compile);
	};
}
