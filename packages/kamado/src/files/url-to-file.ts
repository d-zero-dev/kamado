import type { CompilableFile, GetFileOptions } from './types.js';

import path from 'node:path';

import { urlToLocalPath } from '@d-zero/shared/url-to-local-path';

import { getFile } from './get-file.js';

/**
 * Creates a CompilableFile object from a URL
 * @param url - URL path (e.g., '/about/' or '/products/item.html')
 * @param options - Options for getting the file
 * @param options.inputDir - Input directory path
 * @param options.outputDir - Output directory path
 * @param options.outputExtension - Output file extension (e.g., '.html')
 * @returns CompilableFile object
 * @example
 * ```typescript
 * const file = urlToFile('/about/', {
 *   inputDir: './src',
 *   outputDir: './dist',
 *   outputExtension: '.html',
 * });
 * ```
 */
export function urlToFile(url: string | URL, options: GetFileOptions): CompilableFile {
	const urlString = typeof url === 'string' ? url : url.href;
	const relativePath = urlToLocalPath(urlString, options.outputExtension);
	const filePath = path.resolve(options.inputDir, relativePath);
	return getFile(filePath, options);
}
