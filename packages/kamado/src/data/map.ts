import type { Config } from '../config/types.js';
import type { CompilableFile } from '../files/types.js';

import { getAssetGroup } from './get-asset-group.js';

/**
 *
 * @param config
 */
export async function getCompilableFileMap(config: Config) {
	const map = new Map<string, CompilableFile>();

	for (const compilerEntry of config.compilers) {
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
