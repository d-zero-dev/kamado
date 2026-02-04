import type { FileObject } from 'kamado/files';

import path from 'node:path';

import fg from 'fast-glob';

/**
 * Options for getting layouts
 */
export interface GetLayoutsOptions {
	/**
	 * Directory path where layout files are stored
	 */
	dir?: string;
}

/**
 * Gets layout files
 * @param options - Options for getting layouts
 * @param options.dir - Directory path where layout files are stored
 * @returns Map of layout files (empty object if dir is not provided)
 */
export async function getLayouts(options: GetLayoutsOptions) {
	if (!options.dir) {
		return {};
	}

	const layoutsFilePaths = await fg(path.resolve(options.dir, '*'));
	let layouts: Record<string, FileObject> = {};
	for (const layoutsFilePath of layoutsFilePaths) {
		layouts = {
			...layouts,
			...getLayout(layoutsFilePath),
		};
	}
	return layouts;
}

/**
 * Gets a single layout file
 * @param filePath - Path to the layout file
 * @returns Object containing the layout file (keyed by filename)
 */
function getLayout(filePath: string): Record<string, FileObject> {
	const name = path.basename(filePath);
	return {
		[name]: {
			inputPath: filePath,
		},
	};
}
