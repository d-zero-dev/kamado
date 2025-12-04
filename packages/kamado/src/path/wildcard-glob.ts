import type { Extension } from '../files/types.js';

/**
 *
 * @param extensions
 */
export function wildcardGlob(extensions: Extension[]) {
	return extensions.length > 1 ? `*.{${extensions.join(',')}}` : `*.${extensions[0]}`;
}
