import type { CompilerDefine } from './types.js';
import type { Config } from '../config/types.js';
import type { MetaData } from '../files/types.js';

/**
 *
 * @param config
 */
export function createCompileFunctions<M extends MetaData>(config: Config<M>) {
	const compilerHelper: CompilerDefine<M> = (factory, options) => factory(options);
	return config.compilers(compilerHelper);
}
