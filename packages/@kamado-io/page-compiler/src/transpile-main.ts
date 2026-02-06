import type { CompileData, CompileHook } from './types.js';
import type { CompilableFile, MetaData } from 'kamado/files';

import c from 'ansi-colors';

import { transpile } from './transpile.js';

/**
 * Required context for transpiling main content
 */
export interface TranspileMainContext<M extends MetaData> {
	readonly content: string;
	readonly compileData: CompileData<M>;
	readonly file: CompilableFile;
}

/**
 * Optional options for transpiling main content
 */
export interface TranspileMainOptions<M extends MetaData> {
	readonly compileHook?: CompileHook<M>;
	readonly log?: (message: string) => void;
}

/**
 * Transpiles main content using the provided compile hooks.
 * Executes the before hook, compiler, and after hook in sequence.
 * If no compile hook is provided, returns the content as-is.
 *
 * IMPORTANT: This preserves the original behavior where if no compiler is specified,
 * the before hook result is IGNORED and the original content is returned.
 * @param context - Required context (content, compileData, file)
 * @param options - Optional options (compileHook, log)
 * @returns Transpiled HTML content
 * @throws {Error} if compilation fails
 */
export async function transpileMainContent<M extends MetaData>(
	context: TranspileMainContext<M>,
	options?: TranspileMainOptions<M>,
): Promise<string> {
	const { content, compileData, file } = context;
	const { compileHook, log } = options ?? {};

	return transpile(
		{
			content,
			compileData,
			extension: file.extension,
		},
		{
			compileHook,
			log,
			compileLogMessage: 'Compiling main content...',
			compileLogColor: c.yellowBright,
			errorLogMessage: file.inputPath,
			errorMessage: `Failed to compile the page: ${file.inputPath}`,
			useBeforeResultWhenNoCompiler: false, // Main content behavior: ignore before hook result
		},
	);
}
