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
) => Promise<string> {
	return async (content: string, data: Record<string, unknown>, extension: string) => {
		// Check if the file extension is .pug
		if (extension !== '.pug') {
			// If not .pug, return content as-is
			return content;
		}
		// If .pug, compile it
		return compiler(content, data);
	};
}

/**
 * Creates compile hooks for page-compiler
 * @param options - Pug compiler options
 * @returns Function that returns compile hooks object
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
	const compiler = compilePug(options);
	const compilerWithExtensionCheck = createCompilerWithExtensionCheck(compiler);
	return () => ({
		main: { compiler: compilerWithExtensionCheck },
		layout: { compiler: compilerWithExtensionCheck },
	});
}
