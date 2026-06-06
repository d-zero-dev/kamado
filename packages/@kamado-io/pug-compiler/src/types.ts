import type { Options as PugOptions } from 'pug';

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
 * @param template - Pug template source
 * @param data - Data object passed to the compiled template
 * @param cache - Whether the compiled template function may be reused from
 *   cache. `false` in serve mode so that include/extends changes are always
 *   reflected. Default: `true`
 */
export type CompilerFunction = (
	template: string,
	data: Record<string, unknown>,
	cache?: boolean,
) => Promise<string>;
