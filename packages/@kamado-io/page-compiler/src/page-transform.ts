import type { Transform } from 'kamado/config';

// Import transform factories for defaultPageTransforms
import { characterEntities } from './transform/character-entities.js';
import { doctype } from './transform/doctype.js';
import { lineBreak } from './transform/line-break.js';
import { manipulateDOM } from './transform/manipulate-dom.js';
import { minifier } from './transform/minifier.js';
import { prettier } from './transform/prettier.js';

/**
 * Default page transforms with sensible settings
 */
export const defaultPageTransforms: Transform[] = [
	// DOM manipulation phase (imageSizes is integrated)
	manipulateDOM({ imageSizes: true }),

	// Postprocess phase
	characterEntities(),
	doctype(),
	prettier(),
	minifier(),
	lineBreak(),
];
