import type { CompileFunction } from './index.js';
import type { Config } from '../config/types.js';
import type { OutputFileType } from '../files/types.js';

/**
 *
 * @param config
 */
export async function createCompileFunctionMap(config: Config) {
	const compilers = new Map<OutputFileType, CompileFunction>();
	if (config.compilers) {
		for (const [extension, compilerPlugin] of Object.entries(config.compilers)) {
			const compileFunction = await compilerPlugin(config);
			compilers.set(extension as OutputFileType, compileFunction);
		}
	}
	return compilers;
}
