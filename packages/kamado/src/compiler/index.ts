import type { Config } from '../config/types.js';
import type { CompilableFile } from '../files/types.js';

/**
 * Compiler plugin interface
 * Function that takes options and returns a compiler
 */
export interface CompilerPlugin<CompileOptions = void> {
	/**
	 * @param options - Compile options
	 * @returns Compiler function
	 */
	(options?: CompileOptions): Compiler;
}

/**
 * Compiler interface
 * Function that takes configuration and returns a compile function
 */
export interface Compiler {
	/**
	 * @param config - Configuration object
	 * @returns Compile function
	 */
	(config: Config): Promise<CompileFunction> | CompileFunction;
}

/**
 * Compile function interface
 * Function that takes a compilable file and returns compilation result
 */
export interface CompileFunction {
	/**
	 * @param compilableFile - File to compile
	 * @param log - Log output function (optional)
	 * @returns Compilation result (string or ArrayBuffer)
	 */
	(
		compilableFile: CompilableFile,
		log?: (message: string) => void,
	): Promise<string | ArrayBuffer> | string | ArrayBuffer;
}

/**
 * Creates a compiler
 * @param compiler - Compiler plugin function
 * @returns Compiler plugin function (returns as-is)
 * @example
 * ```typescript
 * const myCompiler = createCompiler((options) => async (config) => {
 *   return async (file, log) => {
 *     const content = await file.get();
 *     return processContent(content);
 *   };
 * });
 * ```
 */
export function createCompiler<CompileOptions>(
	compiler: CompilerPlugin<CompileOptions>,
): CompilerPlugin<CompileOptions> {
	return compiler;
}
