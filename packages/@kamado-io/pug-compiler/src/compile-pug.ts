import type { CompilerFunction, PugCompilerOptions } from './types.js';
import type { Options as PugOptions } from 'pug';

import pug from 'pug';

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
