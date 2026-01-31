import type { CustomCompilerWithMetadata } from '../compiler/types.js';
import type { CompilableFile } from '../files/types.js';

import path from 'node:path';

import fg from 'fast-glob';
import picomatch from 'picomatch';

import { getFile } from '../files/get-file.js';

/**
 * Required context for getting asset files
 */
export interface GetAssetGroupContext {
	readonly inputDir: string;
	readonly outputDir: string;
	readonly compilerEntry: CustomCompilerWithMetadata;
}

/**
 * Optional options for getting asset files
 */
export interface GetAssetGroupOptions {
	readonly glob?: string;
}

/**
 * Gets asset files for the specified compiler entry
 * @param context - Required context (inputDir, outputDir, compilerEntry)
 * @param options - Optional options (glob)
 * @returns List of asset files
 */
export async function getAssetGroup(
	context: GetAssetGroupContext,
	options?: GetAssetGroupOptions,
): Promise<CompilableFile[]> {
	const { inputDir, outputDir, compilerEntry } = context;
	const baseGlob = path.resolve(inputDir, compilerEntry.files);

	const fgOptions: {
		cwd: string;
		ignore?: string[];
	} = {
		cwd: inputDir,
	};
	if (compilerEntry.ignore) {
		fgOptions.ignore = [compilerEntry.ignore];
	}

	let filePaths = await fg(baseGlob, fgOptions);

	if (options?.glob) {
		const isMatch = picomatch(options.glob);
		filePaths = filePaths.filter((filePath) => isMatch(filePath));
	}

	const results: CompilableFile[] = [];

	for (const filePath of filePaths) {
		const file = getFile(filePath, {
			inputDir,
			outputDir,
			outputExtension: compilerEntry.outputExtension,
		});

		results.push(file);
	}

	return results;
}
