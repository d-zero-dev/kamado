import type { Transform, TransformContext } from 'kamado/config';
import type { MetaData } from 'kamado/files';

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Options for SSI shim transform function
 */
export interface SSIShimTransformOptions {
	/**
	 * Server document root path to simulate
	 * When specified, virtual paths are treated as absolute paths from this document root,
	 * and the relative portion is resolved against ctx.context.dir.output
	 *
	 * This is useful for simulating actual server document root behavior where SSI paths
	 * reference the production server's absolute paths.
	 * @example
	 * If dir="/home/www/document_root/" and virtual="/home/www/document_root/includes/header.html"
	 * then the actual file read will be: path.join(ctx.context.dir.output, "includes/header.html")
	 * @example Without dir option
	 * ```typescript
	 * createSSIShim()
	 * // <!--#include virtual="/header.html" --> reads from {output}/header.html
	 * ```
	 * @example With dir option
	 * ```typescript
	 * createSSIShim({ dir: '/home/www/document_root/' })
	 * // <!--#include virtual="/home/www/document_root/includes/header.html" -->
	 * // reads from {output}/includes/header.html
	 * ```
	 */
	readonly dir?: string;
	/**
	 * Custom error handler for when included files cannot be read
	 * @param includePath - The path that failed to load
	 * @param error - The error that occurred
	 * @returns Replacement content (empty string by default)
	 */
	readonly onError?: (includePath: string, error: unknown) => string | Promise<string>;
}

/**
 * Options for SSI shim utility (includes filter options)
 */
export interface SSIShimOptions extends SSIShimTransformOptions {
	/**
	 * Filter options to limit which files this transform applies to
	 */
	readonly filter?: {
		/**
		 * Glob pattern(s) to include
		 * @default '**\/*.html'
		 */
		readonly include?: string | readonly string[];
		/**
		 * Glob pattern(s) to exclude
		 */
		readonly exclude?: string | readonly string[];
	};
}

/**
 * Create a transform function that implements pseudo Server Side Includes (SSI)
 * This is the core transform function without filter configuration.
 * Use this when you want to create custom ResponseTransform objects.
 *
 * Processes `<!--#include virtual="/path/to/file.html" -->` directives in HTML files
 * and replaces them with the content of the referenced files.
 * Can be used in both development and build contexts.
 * @param options - Transform options
 * @param name - Transform name used for logging (default: 'ssiShim')
 * @returns Transform function (content, context) => Promise<string | ArrayBuffer>
 * @example Creating a custom ResponseTransform
 * ```typescript
 * import { createSSIShimTransform } from '@kamado-io/page-compiler/transform/ssi-shim';
 *
 * export const config: UserConfig = {
 *   devServer: {
 *     transforms: [
 *       {
 *         name: 'my-ssi',
 *         filter: { include: '**\/*.html' },
 *         transform: createSSIShimTransform({
 *           onError: (path) => `<!-- Failed: ${path} -->`,
 *         }),
 *       },
 *     ],
 *   },
 * };
 * ```
 */
export function createSSIShimTransform<M extends MetaData>(
	options: SSIShimTransformOptions = {},
	name = 'ssiShim',
) {
	return async (
		content: string | ArrayBuffer,
		ctx: TransformContext<M>,
	): Promise<string | ArrayBuffer> => {
		// Decode ArrayBuffer to string if needed
		let htmlContent: string;
		if (typeof content === 'string') {
			htmlContent = content;
		} else {
			const decoder = new TextDecoder('utf-8');
			htmlContent = decoder.decode(content);
		}

		// Match SSI include directives: <!--#include virtual="/path/to/file.html" -->
		const includeRegex = /<!--#include\s+virtual="([^"]+)"\s*-->/g;
		let result = htmlContent;

		// Process each include directive
		for (const match of htmlContent.matchAll(includeRegex)) {
			const includePath = match[1];
			const fullMatch = match[0];

			// Skip if includePath is not captured
			if (!includePath) {
				continue;
			}

			// Resolve the file path
			let filePath: string;
			if (options.dir) {
				// When dir is specified, treat includePath as absolute path from document root
				// Calculate relative path and resolve against output directory
				const relativePath = path.relative(options.dir, includePath);
				filePath = path.join(ctx.context.dir.output, relativePath);
			} else {
				// Default behavior: resolve relative to output directory
				filePath = path.resolve(ctx.context.dir.output, includePath.replace(/^\//, ''));
			}

			// Guard: Prevent path traversal outside the output directory
			const resolvedOutputDir = path.resolve(ctx.context.dir.output);
			if (
				!filePath.startsWith(resolvedOutputDir + path.sep) &&
				filePath !== resolvedOutputDir
			) {
				// eslint-disable-next-line no-console
				console.warn(`[${name}] Blocked path traversal attempt: ${includePath}`);
				result = result.replace(fullMatch, '');
				continue;
			}

			try {
				// Read the included file
				const includeContent = await fs.readFile(filePath, 'utf8');
				result = result.replace(fullMatch, includeContent);
			} catch (error) {
				// Handle error (custom handler or default)
				const errorContent = options.onError
					? await Promise.resolve(options.onError(includePath, error))
					: '';

				// Log warning if no custom error handler
				if (!options.onError) {
					// eslint-disable-next-line no-console
					console.warn(
						`[${name}] Failed to include ${includePath}:`,
						error instanceof Error ? error.message : String(error),
					);
				}

				result = result.replace(fullMatch, errorContent);
			}
		}

		return result;
	};
}

/**
 * Create a complete ResponseTransform that implements pseudo Server Side Includes (SSI)
 * This is a convenience wrapper around createSSIShimTransform with filter configuration.
 * Returns a ResponseTransform object with name and filter included, which can be used directly
 * or customized via spread syntax.
 *
 * Processes `<!--#include virtual="/path/to/file.html" -->` directives in HTML files
 * and replaces them with the content of the referenced files.
 * Can be used in both development (devServer.transforms) and build contexts (beforeSerialize hook).
 * @param options - Configuration options including filters
 * @returns ResponseTransform object for use in devServer.transforms or with beforeSerialize
 * @example Usage in devServer.transforms
 * ```typescript
 * import { createSSIShim } from '@kamado-io/page-compiler/transform/ssi-shim';
 *
 * export const config: UserConfig = {
 *   devServer: {
 *     transforms: [
 *       createSSIShim(),
 *     ],
 *   },
 * };
 * ```
 * @example Customizing with spread syntax
 * ```typescript
 * transforms: [
 *   {
 *     ...createSSIShim(),
 *     name: 'my-ssi',
 *     filter: { include: ['**\/*.html', '**\/*.htm'] },
 *   },
 * ]
 * ```
 * @example With custom error handling
 * ```typescript
 * createSSIShim({
 *   onError: (path, error) => {
 *     console.error(`Failed to include ${path}:`, error);
 *     return `<!-- Failed to include: ${path} -->`;
 *   },
 * })
 * ```
 * @example Simulating server document root
 * ```typescript
 * createSSIShim({
 *   dir: '/home/www/document_root/',
 * })
 * // In HTML: <!--#include virtual="/home/www/document_root/includes/header.html" -->
 * // Will read from: {output}/includes/header.html
 * ```
 * @example In HTML files
 * ```html
 * <!DOCTYPE html>
 * <html>
 *   <head>
 *     <title>My Page</title>
 *   </head>
 *   <body>
 *     <!--#include virtual="/header.html" -->
 *     <main>Content here</main>
 *     <!--#include virtual="/footer.html" -->
 *   </body>
 * </html>
 * ```
 */
export function createSSIShim<M extends MetaData>(
	options: SSIShimOptions = {},
): Transform<M> {
	return {
		name: 'ssiShim',
		filter: {
			include: options.filter?.include ?? '**/*.html',
			exclude: options.filter?.exclude,
		},
		transform: createSSIShimTransform(options, 'ssiShim'),
	};
}
