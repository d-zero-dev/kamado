import type { PageCompilerOptions } from '../types.js';

import { minify } from 'html-minifier-terser';

/**
 * Options for HTML minification
 */
export interface MinifierOptions {
	/**
	 * HTML minifier configuration options
	 * - Set to false to disable minification
	 * - Set to an object to customize minification settings
	 * - Undefined defaults to enabled with default settings
	 * @default true
	 */
	readonly minifier?: PageCompilerOptions['minifier'];
}

/**
 * Minifies HTML content using html-minifier-terser.
 *
 * Uses sensible defaults that preserve formatting while removing redundant attributes
 * and minifying embedded CSS/JS.
 * @param options - Configuration options
 * @returns A function that takes content and returns a Promise of minified content
 * @internal
 */
export function minifier(
	options?: MinifierOptions,
): (content: string | ArrayBuffer) => Promise<string | ArrayBuffer> {
	return async (content: string | ArrayBuffer): Promise<string | ArrayBuffer> => {
		if (typeof content !== 'string') {
			return content;
		}

		const { minifier: minifierOption } = options ?? {};

		// Default to enabled if undefined
		if (minifierOption ?? true) {
			const minifierConfig = typeof minifierOption === 'object' ? minifierOption : {};
			return await minify(content, {
				collapseWhitespace: false,
				collapseBooleanAttributes: true,
				removeComments: false,
				removeRedundantAttributes: true,
				removeScriptTypeAttributes: true,
				removeStyleLinkTypeAttributes: true,
				useShortDoctype: false,
				minifyCSS: true,
				minifyJS: true,
				...minifierConfig,
			});
		}

		return content;
	};
}
