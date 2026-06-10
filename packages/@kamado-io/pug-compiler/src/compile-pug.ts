import type { CompilerFunction, PugCompilerOptions } from './types.js';
import type { Options as PugOptions } from 'pug';

import pug from 'pug';

/**
 * Maximum number of compiled template functions kept per compiler instance.
 * Shared layouts stay hot via LRU refresh; unique page templates churn
 * through without growing memory unboundedly on large sites.
 */
const TEMPLATE_CACHE_LIMIT = 256;

/**
 * Creates a Pug compiler function
 *
 * Compiled template functions are cached per compiler instance, keyed by the
 * template source string, so shared templates (e.g. layouts) are compiled
 * once and rendered many times. Pass `cache = false` (serve mode) to bypass
 * the cache — includes/extends are then re-read on every compilation.
 * @param options - Pug compiler options
 * @returns Compiler function that takes template, data, and a cache flag
 * @example
 * ```typescript
 * const compiler = compilePug({
 *   pathAlias: './src',
 *   doctype: 'html',
 *   pretty: true,
 * });
 * const html = await compiler('p Hello, world!', { title: 'My Page' });
 * ```
 */
export function compilePug(options: PugCompilerOptions = {}): CompilerFunction {
	const pugOptions: PugOptions = {
		basedir: options.pathAlias ?? options.basedir,
		doctype: options.doctype ?? 'html',
		pretty: options.pretty ?? true,
		...options,
	};

	const templateCache = new Map<string, pug.compileTemplate>();

	return (
		template: string,
		data: Record<string, unknown>,
		cache = true,
	): Promise<string> => {
		try {
			let compiler = cache ? templateCache.get(template) : undefined;
			if (compiler) {
				// Refresh LRU position so frequently used templates (layouts) stay
				// hot. Plain FIFO would NOT suffice here: once unique page templates
				// exceed the cache limit, a shared layout inserted early would be
				// evicted every TEMPLATE_CACHE_LIMIT pages and recompiled — exactly
				// the cost this cache exists to avoid
				templateCache.delete(template);
				templateCache.set(template, compiler);
			} else {
				compiler = pug.compile(template, pugOptions);
				if (cache) {
					if (templateCache.size >= TEMPLATE_CACHE_LIMIT) {
						// Evict the least recently used entry (first key in insertion order)
						const oldestKey = templateCache.keys().next().value;
						if (oldestKey !== undefined) {
							templateCache.delete(oldestKey);
						}
					}
					templateCache.set(template, compiler);
				}
			}
			return Promise.resolve(compiler(data));
		} catch (error) {
			return Promise.reject(
				new Error(
					`Failed to compile Pug template: ${error instanceof Error ? error.message : String(error)}`,
					{
						cause: error,
					},
				),
			);
		}
	};
}
