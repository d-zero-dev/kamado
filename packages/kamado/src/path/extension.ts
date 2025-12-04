import type {
	Extension,
	ExtensionOutputTypeMap,
	OutputFileType,
} from '../files/types.js';

/**
 * Extracts list of extensions corresponding to the specified output file type
 * @param type - Output file type
 * @param extensions - Mapping of extensions to output file types
 * @returns Array of corresponding extensions
 */
export function extractExtensions(
	type: OutputFileType,
	extensions: ExtensionOutputTypeMap,
): Extension[] {
	const result: Extension[] = [];
	for (const [ext, outputFileType] of Object.entries(extensions)) {
		if (outputFileType === type) {
			result.push(ext as Extension);
		}
	}
	return result;
}
