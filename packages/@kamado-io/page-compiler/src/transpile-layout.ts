import type { CompileData, CompileHook } from './types.js';
import type { CompilableFile, FileObject, MetaData } from 'kamado/files';

import c from 'ansi-colors';

import { transpile } from './transpile.js';

/**
 * Required context for transpiling layout
 */
export interface TranspileLayoutContext<M extends MetaData> {
	readonly layoutContent: string;
	readonly layoutCompileData: CompileData<M>;
	readonly layoutExtension: string;
	readonly layout: FileObject;
	readonly file: CompilableFile;
}

/**
 * Optional options for transpiling layout
 */
export interface TranspileLayoutOptions<M extends MetaData> {
	readonly compileHook?: CompileHook<M>;
	readonly log?: (message: string) => void;
}

/**
 * Transpiles layout using the provided compile hooks.
 * Executes the before hook, compiler, and after hook in sequence.
 * If no compile hook is provided, returns the content as-is.
 *
 * IMPORTANT: This preserves the original behavior where if no compiler is specified,
 * the before hook result is USED (different from main content transpilation).
 * @param context - Required context (layoutContent, layoutCompileData, layoutExtension, layout, file)
 * @param options - Optional options (compileHook, log)
 * @returns Transpiled HTML content
 * @throws {Error} if compilation fails
 */
export async function transpileLayout<M extends MetaData>(
	context: TranspileLayoutContext<M>,
	options?: TranspileLayoutOptions<M>,
): Promise<string> {
	const { layoutContent, layoutCompileData, layoutExtension, layout, file } = context;
	const { compileHook, log } = options ?? {};

	return transpile(
		{
			content: layoutContent,
			compileData: layoutCompileData,
			extension: layoutExtension,
		},
		{
			compileHook,
			log,
			compileLogMessage: 'Compiling layout...',
			compileLogColor: c.greenBright,
			errorLogMessage: `Layout: ${layout.inputPath} (Content: ${file.inputPath})`,
			errorMessage: `Failed to compile the layout: ${layout.inputPath}`,
			useBeforeResultWhenNoCompiler: true, // Layout behavior: use before hook result
		},
	);
}
