import type { CompileFunction } from './index.js';
import type { Context } from '../config/types.js';

/**
 * Creates a map of output extensions to compile functions
 * @param context - Execution context
 * @returns Map of output extension to compile function
 */
export async function createCompileFunctionMap(context: Context) {
	const compilers = new Map<string, CompileFunction>();
	for (const compilerWithMetadata of context.compilers) {
		const compileFunction = await compilerWithMetadata.compiler(context);
		compilers.set(compilerWithMetadata.outputExtension, compileFunction);
	}
	return compilers;
}
