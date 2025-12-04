import type { Extension } from '../files/types.js';

/**
 * Generates wildcard glob pattern from list of extensions
 * @param extensions - Array of extensions (must not be empty)
 * @returns Glob pattern string (e.g., "*.{html,pug}" or "*.html")
 * @example
 * ```typescript
 * wildcardGlob(['html', 'pug']); // Returns: "*.{html,pug}"
 * wildcardGlob(['html']); // Returns: "*.html"
 * ```
 */
export function wildcardGlob(extensions: Extension[]) {
	return extensions.length > 1 ? `*.{${extensions.join(',')}}` : `*.${extensions[0]}`;
}
