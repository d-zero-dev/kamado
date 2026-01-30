import type { Context } from '../config/types.js';
import type { CompilableFile } from '../files/types.js';

/**
 * Compile function interface
 * Compiles a file based on its output extension using the appropriate compiler from the function map
 */
export interface CompileFunction {
	/**
	 * @param file - File to compile (CompilableFile or file seed with inputPath and outputExtension)
	 * @param log - Log output function (optional)
	 * @param cache - Whether to cache the file content (default: true)
	 * @returns Compilation result (string or ArrayBuffer)
	 */
	(
		file:
			| {
					readonly inputPath: string;
					readonly outputExtension: string;
			  }
			| CompilableFile,
		log?: (message: string) => void,
		cache?: boolean,
	): Promise<string | ArrayBuffer>;
}

/**
 * Compiler context with compile function map
 * Extends Context to include a map of compiler functions by output extension
 */
export interface CompilerContext extends Context {
	/**
	 * Map of compiler functions keyed by output file extension (e.g., '.html', '.css', '.js')
	 */
	readonly compileFunctionMap: Map<string, CustomCompileFunction>;
}

/**
 * Compile function interface
 * Function that takes a compilable file and returns compilation result
 */
export interface CustomCompileFunction {
	/**
	 * @param compilableFile - File to compile
	 * @param compile - Recursive compiler function to compile other files during compilation
	 * @param log - Log output function (optional)
	 * @param cache - Whether to cache the file content (default: true)
	 * @returns Compilation result (string or ArrayBuffer)
	 */
	(
		compilableFile: CompilableFile,
		compile: CompileFunction,
		log?: (message: string) => void,
		cache?: boolean,
	): Promise<string | ArrayBuffer> | string | ArrayBuffer;
}

/**
 * Compiler interface
 * Function that takes execution context and returns a compile function
 */
export interface CustomCompiler {
	/**
	 * @param context - Execution context (config + mode)
	 * @returns Compile function
	 */
	(context: Context): Promise<CustomCompileFunction> | CustomCompileFunction;
}

/**
 * Compiler plugin interface
 * Function that takes options and returns a compiler
 */
export interface CustomCompilerPlugin<CustomCompileOptions = void> {
	/**
	 * @param options - Compile options
	 * @returns Compiler function
	 */
	(options?: CustomCompileOptions): CustomCompiler;
}

/**
 * Options for compiler metadata
 * These options can be specified by users to override default values
 */
export interface CustomCompilerMetadataOptions {
	/**
	 * Glob pattern for files to compile (joined with dir.input)
	 */
	readonly files?: string;
	/**
	 * Glob pattern for files to exclude from compilation
	 * Patterns are resolved relative to dir.input
	 */
	readonly ignore?: string;
	/**
	 * Output file extension (e.g., '.html', '.css', '.js', '.php')
	 */
	readonly outputExtension?: string;
}

/**
 * Compiler with metadata
 * Contains compiler function and metadata for file matching
 */
export interface CustomCompilerWithMetadata {
	/**
	 * Glob pattern for files to compile (joined with dir.input)
	 */
	readonly files: string;
	/**
	 * Glob pattern for files to exclude from compilation
	 * Patterns are resolved relative to dir.input
	 */
	readonly ignore?: string;
	/**
	 * Output file extension (e.g., '.html', '.css', '.js', '.php')
	 */
	readonly outputExtension: string;
	/**
	 * Compiler function
	 */
	readonly compiler: CustomCompiler;
}

/**
 * Result of compiler factory function
 */
export interface CustomCompilerFactoryResult<CustomCompileOptions> {
	/**
	 * Default glob pattern for files to compile
	 */
	readonly defaultFiles: string;
	/**
	 * Default output file extension
	 */
	readonly defaultOutputExtension: string;
	/**
	 * Compiler function that takes options and returns a compiler
	 */
	readonly compile: (
		options?: CustomCompileOptions & CustomCompilerMetadataOptions,
	) => CustomCompiler;
}
