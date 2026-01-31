import type { CompileData, CompileHook } from './types.js';

import c from 'ansi-colors';

/**
 * Required context for the transpile function
 */
export interface TranspileContext {
	/**
	 * Content to transpile
	 */
	readonly content: string;
	/**
	 * Data object passed to the compiler and hooks
	 */
	readonly compileData: CompileData;
	/**
	 * File extension for the compiler
	 */
	readonly extension: string;
}

/**
 * Optional options for the transpile function
 */
export interface TranspileOptions {
	/**
	 * Compile hook configuration
	 */
	readonly compileHook?: CompileHook;
	/**
	 * Optional logging function
	 */
	readonly log?: (message: string) => void;
	/**
	 * Log message to display during compilation
	 */
	readonly compileLogMessage?: string;
	/**
	 * ANSI color function for the compile log message
	 * @example c.yellowBright, c.greenBright
	 */
	readonly compileLogColor?: (str: string) => string;
	/**
	 * Error log message to display when compilation fails
	 */
	readonly errorLogMessage?: string;
	/**
	 * Error message for the thrown Error
	 */
	readonly errorMessage?: string;
	/**
	 * Whether to use the before hook result when no compiler is specified
	 * - true: Use processedContent (layout behavior)
	 * - false: Use original content (main content behavior)
	 * @default false
	 */
	readonly useBeforeResultWhenNoCompiler?: boolean;
}

/**
 * Generic transpile function that executes compile hooks in sequence.
 * Handles before hook, compiler, and after hook execution with customizable behavior.
 * @param context - Required transpile context (content, compileData, extension)
 * @param options - Optional transpile options (hooks, logging, etc.)
 * @returns Transpiled HTML content
 * @throws {Error} if compilation fails
 */
export async function transpile(
	context: TranspileContext,
	options?: TranspileOptions,
): Promise<string> {
	const { content, compileData, extension } = context;
	const {
		compileHook,
		log,
		compileLogMessage,
		compileLogColor,
		errorLogMessage,
		errorMessage,
		useBeforeResultWhenNoCompiler = false,
	} = options ?? {};

	if (!compileHook) {
		return content;
	}

	try {
		let processedContent = content;

		// Apply before hook
		if (compileHook.before) {
			processedContent = await compileHook.before(processedContent, compileData);
		}

		// Compile
		let result: string;
		if (compileHook.compiler) {
			if (log && compileLogMessage && compileLogColor) {
				log(compileLogColor(compileLogMessage));
			}
			result = await compileHook.compiler(processedContent, compileData, extension);
		} else {
			// Behavior depends on useBeforeResultWhenNoCompiler flag
			result = useBeforeResultWhenNoCompiler ? processedContent : content;
		}

		// Apply after hook
		if (compileHook.after) {
			result = await compileHook.after(result, compileData);
		}

		return result;
	} catch (error) {
		if (log && errorLogMessage) {
			log(c.red(`❌ ${errorLogMessage}`));
		}
		throw new Error(errorMessage ?? 'Compilation failed', {
			cause: error,
		});
	}
}
