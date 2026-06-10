import type { CompilerFunction, PugCompilerOptions } from './types.js';
import type { CompileHooksObject } from '@kamado-io/page-compiler';
import type { MetaData } from 'kamado/files';

import { compilePug } from './compile-pug.js';

/**
 * Creates a compiler function with extension check
 * @param compiler
 */
function createCompilerWithExtensionCheck(
	compiler: CompilerFunction,
): (
	content: string,
	data: Record<string, unknown>,
	extension: string,
	cache?: boolean,
) => Promise<string> {
	return async (
		content: string,
		data: Record<string, unknown>,
		extension: string,
		cache?: boolean,
	) => {
		// Check if the file extension is .pug
		if (extension !== '.pug') {
			// If not .pug, return content as-is
			return content;
		}
		// If .pug, compile it
		return compiler(content, data, cache);
	};
}

/**
 * Creates compile hooks for page-compiler
 *
 * Each invocation of the returned factory creates a fresh Pug compiler
 * instance with a fresh template cache. The page compiler resolves the
 * factory once per build/serve context, so the template cache's lifetime is
 * bound to a single build.
 * @param options - Pug compiler options
 * @returns Factory that returns a compile hooks object with `main` and
 *   `layout` compilers backed by a context-scoped Pug compiler
 * @example
 * ```typescript
 * import { createPageCompiler } from '@kamado-io/page-compiler';
 * import { createCompileHooks } from '@kamado-io/pug-compiler';
 *
 * export const config = {
 *   compilers: (def) => [
 *     def(createPageCompiler(), {
 *       compileHooks: createCompileHooks({
 *         pathAlias: './src',
 *         doctype: 'html',
 *         pretty: true,
 *       }),
 *     }),
 *   ],
 * };
 * ```
 */
export function createCompileHooks<M extends MetaData>(
	options: PugCompilerOptions,
): () => CompileHooksObject<M> {
	// Create the compiler inside the factory so each resolution (once per
	// build/serve context) gets a fresh compiler instance — and with it a
	// fresh template cache. This keeps the cache lifetime bound to a single
	// build, so include/extends edits between consecutive builds in the same
	// process are always reflected.
	return () => {
		const compiler = compilePug(options);
		const compilerWithExtensionCheck = createCompilerWithExtensionCheck(compiler);
		return {
			main: { compiler: compilerWithExtensionCheck },
			layout: { compiler: compilerWithExtensionCheck },
		};
	};
}
