import type { CompileFunction, CompilerContext } from './types.js';

import path from 'node:path';

import { getFile } from '../files/get-file.js';

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
