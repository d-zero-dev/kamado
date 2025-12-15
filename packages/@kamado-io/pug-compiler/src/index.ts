import type { CompileHooksObject } from '@kamado-io/page-compiler';
import type { Options as PugOptions } from 'pug';

import pug from 'pug';

/**
 * Options for Pug compiler
 */
export interface PugCompilerOptions extends PugOptions {
	/**
	 * Base directory for resolving includes
	 */
	readonly basedir?: string;
	/**
	 * Path alias for Pug templates (alias for basedir)
	 */
	readonly pathAlias?: string;
	/**
	 * Document type
	 * @default 'html'
	 */
	readonly doctype?: string;
	/**
	 * Whether to pretty-print HTML
	 * @default true
	 */
	readonly pretty?: boolean;
}

/**
 * Compiler function type
 */
export type CompilerFunction = (
	template: string,
	data: Record<string, unknown>,
) => Promise<string>;

/**
 * Creates a Pug compiler function
 * @param options - Pug compiler options
 * @returns Compiler function that takes template and data
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

	return (template: string, data: Record<string, unknown>): Promise<string> => {
		try {
			const compiler = pug.compile(template, pugOptions);
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
 * import { pageCompiler } from '@kamado-io/page-compiler';
 * import { createCompileHooks } from '@kamado-io/pug-compiler';
 *
 * export const config = {
 *   compilers: {
 *     page: pageCompiler({
 *       compileHooks: createCompileHooks({
 *         pathAlias: './src',
 *         doctype: 'html',
 *         pretty: true,
 *       }),
 *     }),
 *   },
 * };
 * ```
 */
export function createCompileHooks(
	options: PugCompilerOptions,
): () => CompileHooksObject {
	const compiler = compilePug(options);
	const compilerWithExtensionCheck = createCompilerWithExtensionCheck(compiler);
	return () => ({
		main: { compiler: compilerWithExtensionCheck },
		layout: { compiler: compilerWithExtensionCheck },
	});
}
