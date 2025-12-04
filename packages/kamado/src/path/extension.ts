import type {
	Extension,
	ExtensionOutputTypeMap,
	OutputFileType,
} from '../files/types.js';

/**
 *
 * @param type
 * @param extensions
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
