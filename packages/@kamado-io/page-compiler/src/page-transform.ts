// Import transform factories for defaultPageTransforms
import type { Transform } from 'kamado/config';
import type { MetaData } from 'kamado/files';

import { doctype } from './transform/doctype.js';
import { lineBreak } from './transform/line-break.js';
import { manipulateDOM } from './transform/manipulate-dom.js';
import { minifier } from './transform/minifier.js';
import { prettier } from './transform/prettier.js';

/**
 * Creates the default page transform pipeline: `manipulateDOM`, `doctype`,
 * `prettier`, `minifier`, `lineBreak` (in execution order).
 *
 * Transform failures are routed through the pipeline-level
 * `formatOptions.parseError` policy on `PageCompilerOptions` — there is no
 * per-transform error mode.
 * @template M - Metadata (frontmatter) type for pages handled by these transforms
 * @returns Array of default transforms, ready to use or to extend via
 * `PageCompilerOptions.transforms`
 */
export function createDefaultPageTransforms<M extends MetaData>(): Transform<M>[] {
	return [
		manipulateDOM({ imageSizes: true }),

		// Postprocess phase
		doctype(),
		prettier(),
		minifier(),
		lineBreak(),
	];
}
