import type { CustomCompileFunction } from './types.js';
import type { Context } from '../config/types.js';
import type { MetaData } from '../files/types.js';

import { createCompileFunctions } from './compile-functions.js';

/**
 * Creates a map of output extensions to compile functions
 * @param context - Execution context
 * @returns Map of output extension to compile function
 */
export async function createCompileFunctionMap<M extends MetaData>(context: Context<M>) {
	const compilerMap = new Map<string, CustomCompileFunction>();

	const compilers = createCompileFunctions(context);

	for (const compilerWithMetadata of compilers) {
		const compileFunction = await compilerWithMetadata.compiler(context);
		compilerMap.set(compilerWithMetadata.outputExtension, compileFunction);
	}
	return compilerMap;
}
