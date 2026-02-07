import type { CompilerDefine } from './types.js';
import type { Config } from '../config/types.js';
import type { MetaData } from '../files/types.js';

/**
 * Resolves the compilers callback to produce an array of compiler entries with metadata
 * @param config - Configuration object containing the compilers callback
 * @returns Array of compiler entries with metadata (files, outputExtension, compiler)
 */
export function createCompileFunctions<M extends MetaData>(config: Config<M>) {
	const compilerHelper: CompilerDefine<M> = (factory, options) => factory(options);
	return config.compilers(compilerHelper);
}
