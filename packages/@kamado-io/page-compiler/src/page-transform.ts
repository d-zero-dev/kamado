// Import transform factories for defaultPageTransforms
import type { Transform } from 'kamado/config';
import type { MetaData } from 'kamado/files';

import { doctype } from './transform/doctype.js';
import { lineBreak } from './transform/line-break.js';
import { manipulateDOM } from './transform/manipulate-dom.js';
import { minifier } from './transform/minifier.js';
import { prettier } from './transform/prettier.js';

/**
 * Creates default page transforms
 * @returns Default page transforms
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
