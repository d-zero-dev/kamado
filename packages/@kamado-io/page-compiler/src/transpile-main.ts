import type { CompileData, CompileHook } from './index.js';
import type { CompilableFile } from 'kamado/files';

import c from 'ansi-colors';

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
	let mainContentHtml = content;

	// Apply compileHooks for main content (extension-independent)
	if (compileHook) {
		try {
			let processedContent = content;

			// Apply before hook
			if (compileHook.before) {
				processedContent = await compileHook.before(processedContent, compileData);
			}

			// Compile
			if (compileHook.compiler) {
				log?.(c.yellowBright('Compiling main content...'));
				mainContentHtml = await compileHook.compiler(
					processedContent,
					compileData,
					file.extension,
				);
			}
			// If no compiler is specified, pass through as-is

			// Apply after hook
			if (compileHook.after) {
				mainContentHtml = await compileHook.after(mainContentHtml, compileData);
			}
		} catch (error) {
			log?.(c.red(`❌ ${file.inputPath}`));
			throw new Error(`Failed to compile the page: ${file.inputPath}`, {
				cause: error,
			});
		}
	}

	return mainContentHtml;
}
