import type { Transform } from 'kamado/config';
import type { MetaData } from 'kamado/files';

import { minify, type Options as HMTOptions } from 'html-minifier-terser';

/**
 * Options for minifier
 */
export interface MinifierOptions {
	readonly options?: HMTOptions;
}

/**
 * Creates a transform for HTML minification
 * @param options - Minifier options
 * @returns Transform object
 */
export function minifier<M extends MetaData>(options?: MinifierOptions): Transform<M> {
	return {
		name: 'minifier',
		transform: async (content) => {
			if (typeof content !== 'string') {
				const decoder = new TextDecoder('utf-8');
				content = decoder.decode(content);
			}

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
				...options?.options,
			});
		},
	};
}
