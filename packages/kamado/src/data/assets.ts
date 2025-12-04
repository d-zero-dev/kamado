import type {
	CompilableFile,
	ExtensionOutputTypeMap,
	OutputFileType,
} from '../files/types.js';

import path from 'node:path';

import fg from 'fast-glob';

import { getFile } from '../files/file.js';
import { extractExtensions } from '../path/extension.js';
import { wildcardGlob } from '../path/wildcard-glob.js';

interface GetAssetsOptions {
	readonly inputDir: string;
	readonly outputDir: string;
	readonly extensions: ExtensionOutputTypeMap;
	readonly glob?: string;
}

/**
 * Gets asset files of the specified type
 * @param type - Output file type
 * @param options - Options for getting assets
 * @param options.inputDir - Input directory path
 * @param options.outputDir - Output directory path
 * @param options.extensions - Mapping of extensions to output file types
 * @param options.glob - Glob pattern for search targets (if omitted, searches all files matching the type in inputDir)
 * @returns List of asset files
 * @throws Error if a file type is not supported (via getFile)
 * @example
 * ```typescript
 * const pages = await getAssetGroup('page', {
 *   inputDir: './src',
 *   outputDir: './dist',
 *   extensions: { pug: 'page', html: 'page' },
 *   glob: './src/pages/*.pug',
 * });
 * ```
 */
export async function getAssetGroup(
	type: OutputFileType,
	options: GetAssetsOptions,
): Promise<CompilableFile[]> {
	const extensions = extractExtensions(type, options.extensions);

	const targetGlob =
		options.glob ?? path.resolve(options.inputDir, '**', wildcardGlob(extensions));

	const filePaths = await fg(targetGlob);

	const results: CompilableFile[] = [];

	for (const filePath of filePaths) {
		const ext = path.extname(filePath);
		if (!Object.keys(options.extensions).includes(ext.toLowerCase().slice(1))) {
			continue;
		}

		const file = getFile(filePath, {
			inputDir: options.inputDir,
			outputDir: options.outputDir,
			extensions: options.extensions,
		});

		results.push(file);
	}

	return results;
}
