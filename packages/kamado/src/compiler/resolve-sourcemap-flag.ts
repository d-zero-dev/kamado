import type { SourcemapOption } from './types.js';

/**
 * Resolves a compiler's `sourcemap` option into a concrete boolean for the
 * current execution mode.
 *
 * `context.mode` is fixed for the lifetime of a command, so call this once
 * per build/serve context rather than per file.
 * @param sourcemap - The compiler's `sourcemap` option. `'onServer'` emits
 *   only in serve mode. Default: `'onServer'`
 * @param mode - The execution mode from the context
 * @returns Whether an inline source map should be emitted
 */
export function resolveSourcemapFlag(
	sourcemap: SourcemapOption | undefined,
	mode: 'build' | 'serve',
): boolean {
	const option = sourcemap ?? 'onServer';
	return option === 'onServer' ? mode === 'serve' : option;
}
