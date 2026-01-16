import type { CompileData, CompileHook } from './index.js';
import type { CompilableFile, FileObject } from 'kamado/files';

import c from 'ansi-colors';

/**
 * Transpiles layout using the provided compile hooks.
 * Executes the before hook, compiler, and after hook in sequence.
 * If no compile hook is provided, returns the content as-is.
 *
 * IMPORTANT: This preserves the original behavior where if no compiler is specified,
 * the before hook result is USED (different from main content transpilation).
 * @param layoutContent - Layout content to transpile
 * @param layoutCompileData - Data object passed to the layout compiler
 * @param layoutExtension - File extension of the layout file
 * @param layout - Layout file object
 * @param file - The page file being compiled (for error reporting)
 * @param compileHook - Compile hook configuration
 * @param log - Optional logging function
 * @returns Transpiled HTML content
 * @throws {Error} if compilation fails
 */
export async function transpileLayout(
	layoutContent: string,
	layoutCompileData: CompileData,
	layoutExtension: string,
	layout: FileObject,
	file: CompilableFile,
	compileHook: CompileHook | undefined,
	log?: (message: string) => void,
): Promise<string> {
	let html = layoutContent;

	// Apply compileHooks for layout (extension-independent)
	if (compileHook) {
		try {
			let processedContent = layoutContent;

			// Apply before hook
			if (compileHook.before) {
				processedContent = await compileHook.before(processedContent, layoutCompileData);
			}

			// Compile
			if (compileHook.compiler) {
				log?.(c.greenBright('Compiling layout...'));
				html = await compileHook.compiler(
					processedContent,
					layoutCompileData,
					layoutExtension,
				);
			} else {
				// If no compiler is specified, use layout content as-is
				html = processedContent;
			}

			// Apply after hook
			if (compileHook.after) {
				html = await compileHook.after(html, layoutCompileData);
			}
		} catch (error) {
			log?.(c.red(`❌ Layout: ${layout.inputPath} (Content: ${file.inputPath})`));
			throw new Error(`Failed to compile the layout: ${layout.inputPath}`, {
				cause: error,
			});
		}
	}

	return html;
}
