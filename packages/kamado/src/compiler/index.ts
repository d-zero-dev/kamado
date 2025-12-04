import type { Config } from '../config/types.js';
import type { CompilableFile } from '../files/types.js';

export interface CompilerPlugin<CompileOptions = void> {
	(options?: CompileOptions): Compiler;
}

export interface Compiler {
	(config: Config): Promise<CompileFunction> | CompileFunction;
}

export interface CompileFunction {
	(
		compilableFile: CompilableFile,
		log?: (message: string) => void,
	): Promise<string | ArrayBuffer> | string | ArrayBuffer;
}

/**
 *
 * @param compiler
 */
export function createCompiler<CompileOptions>(
	compiler: CompilerPlugin<CompileOptions>,
): CompilerPlugin<CompileOptions> {
	return compiler;
}
