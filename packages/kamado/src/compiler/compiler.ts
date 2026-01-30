import type { CustomCompileFunction } from './custom-compiler.js';
import type { Context } from '../config/types.js';
import type { CompilableFile } from '../files/types.js';

import path from 'node:path';

import { getFile } from '../files/file.js';

/**
 * Compiler context with compile function map
 * Extends Context to include a map of compiler functions by output extension
 */
export interface CompilerContext extends Context {
	/**
	 * Map of compiler functions keyed by output file extension (e.g., '.html', '.css', '.js')
	 */
	readonly compileFunctionMap: Map<string, CustomCompileFunction>;
}

/**
 * Compile function interface
 * Compiles a file based on its output extension using the appropriate compiler from the function map
 */
export interface CompileFunction {
	/**
	 * @param file - File to compile (CompilableFile or file seed with inputPath and outputExtension)
	 * @param log - Log output function (optional)
	 * @param cache - Whether to cache the file content (default: true)
	 * @returns Compilation result (string or ArrayBuffer)
	 */
	(
		file:
			| {
					readonly inputPath: string;
					readonly outputExtension: string;
			  }
			| CompilableFile,
		log?: (message: string) => void,
		cache?: boolean,
	): Promise<string | ArrayBuffer>;
}

/**
 * Creates a compiler function that compiles files based on their output extension
 * @param context - Compiler context with function map
 * @returns Compile function that selects appropriate compiler based on file extension
 */
export function createCompiler(context: CompilerContext): CompileFunction {
	const self: CompileFunction = async (fileSeed, log, cache) => {
		const file =
			'get' in fileSeed
				? fileSeed
				: getFile(fileSeed.inputPath, {
						inputDir: context.dir.input,
						outputDir: context.dir.output,
						outputExtension: fileSeed.outputExtension,
					});

		let content: string | ArrayBuffer;

		// Find compiler by output extension
		const outputExtension = path.extname(file.outputPath);
		const compile = context.compileFunctionMap.get(outputExtension);
		if (compile) {
			content = await compile(file, self, log, cache);
		} else {
			const { raw } = await file.get(cache);
			content = raw;
		}

		return content;
	};

	return self;
}
