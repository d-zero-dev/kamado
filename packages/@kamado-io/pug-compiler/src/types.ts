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
 */
export type CompilerFunction = (
	template: string,
	data: Record<string, unknown>,
) => Promise<string>;
