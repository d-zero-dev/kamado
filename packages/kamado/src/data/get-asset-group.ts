import type { CustomCompilerWithMetadata } from '../compiler/types.js';
import type { CompilableFile } from '../files/types.js';

import path from 'node:path';

import fg from 'fast-glob';
import picomatch from 'picomatch';

import { getFile } from '../files/get-file.js';

interface GetAssetsOptions {
	readonly inputDir: string;
	readonly outputDir: string;
	readonly compilerEntry: CustomCompilerWithMetadata;
	readonly glob?: string;
}

/**
 * Gets asset files for the specified compiler entry
 * @param options - Options for getting assets
 * @param options.inputDir - Input directory path
 * @param options.outputDir - Output directory path
 * @param options.compilerEntry - Compiler with metadata configuration
 * @param options.glob - Additional glob pattern to filter results (AND condition with compilerEntry.files)
 * @returns List of asset files
 */
export async function getAssetGroup(
	options: GetAssetsOptions,
): Promise<CompilableFile[]> {
	const baseGlob = path.resolve(options.inputDir, options.compilerEntry.files);

	const fgOptions: {
		cwd: string;
		ignore?: string[];
	} = {
		cwd: options.inputDir,
	};
	if (options.compilerEntry.ignore) {
		fgOptions.ignore = [options.compilerEntry.ignore];
	}

	let filePaths = await fg(baseGlob, fgOptions);

	if (options.glob) {
		const isMatch = picomatch(options.glob);
		filePaths = filePaths.filter((filePath) => isMatch(filePath));
	}

	const results: CompilableFile[] = [];

	for (const filePath of filePaths) {
		const file = getFile(filePath, {
			inputDir: options.inputDir,
			outputDir: options.outputDir,
			outputExtension: options.compilerEntry.outputExtension,
		});

		results.push(file);
	}

	return results;
}
