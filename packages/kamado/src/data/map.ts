import type { Config } from '../config/types.js';
import type { CompilableFile } from '../files/types.js';

import { getAssetGroup } from './assets.js';

/**
 *
 * @param config
 */
export async function getCompilableFileMap(config: Config) {
	const map = new Map<string, CompilableFile>();

	const pageFiles = await getAssetGroup('page', {
		inputDir: config.dir.input,
		outputDir: config.dir.output,
		extensions: config.extensions,
	});

	const styleSheetFiles = await getAssetGroup('style', {
		inputDir: config.dir.input,
		outputDir: config.dir.output,
		extensions: config.extensions,
	});

	const scriptFiles = await getAssetGroup('script', {
		inputDir: config.dir.input,
		outputDir: config.dir.output,
		extensions: config.extensions,
	});

	for (const pageFile of pageFiles) {
		map.set(pageFile.outputPath, pageFile);
	}

	for (const styleSheetFile of styleSheetFiles) {
		map.set(styleSheetFile.outputPath, styleSheetFile);
	}

	for (const scriptFile of scriptFiles) {
		map.set(scriptFile.outputPath, scriptFile);
	}

	return map;
}
