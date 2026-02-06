import type { CustomCompileFunction } from './types.js';
import type { Context } from '../config/types.js';
import type { MetaData } from '../files/types.js';

/**
 * Creates a map of output extensions to compile functions
 * @param context - Execution context
 * @returns Map of output extension to compile function
 */
export async function createCompileFunctionMap<M extends MetaData>(context: Context<M>) {
	const compilers = new Map<string, CustomCompileFunction>();
	for (const compilerWithMetadata of context.compilers) {
		const compileFunction = await compilerWithMetadata.compiler(context);
		compilers.set(compilerWithMetadata.outputExtension, compileFunction);
	}
	return compilers;
}
