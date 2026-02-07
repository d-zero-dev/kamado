import type { Config } from '../config/types.js';
import type { CompilableFile, MetaData } from '../files/types.js';

import { createCompileFunctions } from '../compiler/compile-functions.js';

import { getAssetGroup } from './get-asset-group.js';

/**
 * Creates a map of output paths to compilable file objects for all configured compilers
 * @param config - Configuration object containing compiler entries and directory settings
 * @returns Map of output file paths to CompilableFile objects
 */
export async function getCompilableFileMap<M extends MetaData>(config: Config<M>) {
	const map = new Map<string, CompilableFile>();

	const compilers = createCompileFunctions(config);

	for (const compilerEntry of compilers) {
		const files = await getAssetGroup({
			inputDir: config.dir.input,
			outputDir: config.dir.output,
			compilerEntry,
		});

		for (const file of files) {
			map.set(file.outputPath, file);
		}
	}

	return map;
}
