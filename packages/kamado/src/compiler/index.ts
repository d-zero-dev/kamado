import type { Context } from '../config/types.js';
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
 * Function that takes execution context and returns a compile function
 */
export interface Compiler {
	/**
	 * @param context - Execution context (config + mode)
	 * @returns Compile function
	 */
	(context: Context): Promise<CompileFunction> | CompileFunction;
}

/**
 * Compile function interface
 * Function that takes a compilable file and returns compilation result
 */
export interface CompileFunction {
	/**
	 * @param compilableFile - File to compile
	 * @param log - Log output function (optional)
	 * @param cache - Whether to cache the file content (default: true)
	 * @returns Compilation result (string or ArrayBuffer)
	 */
	(
		compilableFile: CompilableFile,
		log?: (message: string) => void,
		cache?: boolean,
	): Promise<string | ArrayBuffer> | string | ArrayBuffer;
}

/**
 * Options for compiler metadata
 * These options can be specified by users to override default values
 */
export interface CompilerMetadataOptions {
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
export interface CompilerWithMetadata {
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
	readonly compiler: Compiler;
}

/**
 * Result of compiler factory function
 */
export interface CompilerFactoryResult<CompileOptions> {
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
	readonly compile: (options?: CompileOptions & CompilerMetadataOptions) => Compiler;
}

/**
 * Creates a compiler with metadata
 * @param factory - Factory function that returns compiler factory result
 * @returns Function that takes options and returns CompilerWithMetadata
 */
export function createCompiler<CompileOptions>(
	factory: () => CompilerFactoryResult<CompileOptions>,
): (options?: CompileOptions & CompilerMetadataOptions) => CompilerWithMetadata {
	return (
		userOptions?: CompileOptions & CompilerMetadataOptions,
	): CompilerWithMetadata => {
		const result = factory();
		const files = userOptions?.files ?? result.defaultFiles;
		const outputExtension = userOptions?.outputExtension ?? result.defaultOutputExtension;
		const ignore = userOptions?.ignore;

		return {
			files,
			ignore,
			outputExtension,
			compiler: result.compile(userOptions),
		};
	};
}
