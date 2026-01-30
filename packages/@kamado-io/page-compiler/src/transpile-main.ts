import type { CompileData, CompileHook } from './types.js';
import type { CompilableFile } from 'kamado/files';

import c from 'ansi-colors';

import { transpile } from './transpile.js';

/**
 * Transpiles main content using the provided compile hooks.
 * Executes the before hook, compiler, and after hook in sequence.
 * If no compile hook is provided, returns the content as-is.
 *
 * IMPORTANT: This preserves the original behavior where if no compiler is specified,
 * the before hook result is IGNORED and the original content is returned.
 * @param content - Main content to transpile
 * @param compileData - Data object passed to the compiler
 * @param file - The file being compiled
 * @param compileHook - Compile hook configuration
 * @param log - Optional logging function
 * @returns Transpiled HTML content
 * @throws {Error} if compilation fails
 */
export async function transpileMainContent(
	content: string,
	compileData: CompileData,
	file: CompilableFile,
	compileHook: CompileHook | undefined,
	log?: (message: string) => void,
): Promise<string> {
	return transpile({
		content,
		compileData,
		extension: file.extension,
		compileHook,
		log,
		compileLogMessage: 'Compiling main content...',
		compileLogColor: c.yellowBright,
		errorLogMessage: file.inputPath,
		errorMessage: `Failed to compile the page: ${file.inputPath}`,
		useBeforeResultWhenNoCompiler: false, // Main content behavior: ignore before hook result
	});
}
