// Import transform factories for defaultPageTransforms
import type { PrettierParseErrorMode } from './transform/prettier.js';
import type { Transform } from 'kamado/config';
import type { MetaData } from 'kamado/files';

import { doctype } from './transform/doctype.js';
import { lineBreak } from './transform/line-break.js';
import { manipulateDOM } from './transform/manipulate-dom.js';
import { minifier } from './transform/minifier.js';
import { prettier } from './transform/prettier.js';

/**
 * Options for createDefaultPageTransforms
 */
export interface DefaultPageTransformsOptions {
	/**
	 * Forwarded to the default prettier transform. See {@link PrettierParseErrorMode}.
	 */
	readonly parseError?: PrettierParseErrorMode;
}

/**
 * Creates the default page transform pipeline: `manipulateDOM`, `doctype`,
 * `prettier`, `minifier`, `lineBreak` (in execution order).
 * @template M - Metadata (frontmatter) type for pages handled by these transforms
 * @param options - Settings forwarded to individual default transforms. See
 * {@link DefaultPageTransformsOptions} for the full list of fields. Currently
 * only `parseError` is forwarded (to the default `prettier` transform).
 * @returns Array of default transforms, ready to use or to extend via
 * `PageCompilerOptions.transforms`
 */
export function createDefaultPageTransforms<M extends MetaData>(
	options?: DefaultPageTransformsOptions,
): Transform<M>[] {
	return [
		manipulateDOM({ imageSizes: true }),

		// Postprocess phase
		doctype(),
		prettier({ parseError: options?.parseError }),
		minifier(),
		lineBreak(),
	];
}
