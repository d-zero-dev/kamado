import type { CompileData } from '@kamado-io/page-compiler';
import type { MetaData } from 'kamado/files';
import type { ReactElement } from 'react';

/**
 * Options for the JSX compiler
 */
export interface JsxCompilerOptions {
	/**
	 * esbuild `jsxImportSource` option
	 * @default 'react'
	 */
	readonly jsxImportSource?: string;
	/**
	 * Additional module specifiers to mark as external, on top of the
	 * always-external `react`/`react-dom` family (kept external so the
	 * bundled component shares the host's single React instance)
	 */
	readonly external?: readonly string[];
	/**
	 * esbuild `alias` option, forwarded as-is
	 */
	readonly alias?: Record<string, string>;
	/**
	 * esbuild `define` option, forwarded as-is
	 */
	readonly define?: Record<string, string>;
}

/**
 * Low-level JSX compiler function
 * @param source - JSX/TSX source code (frontmatter already stripped)
 * @param props - Data passed as the component's sole props argument
 * @param resolveDir - Base directory used to resolve relative imports
 * @param filePath - Absolute path of the file `source` originated from, used
 *   for `//# sourceURL=` annotations and error messages
 * @param cache - Whether a previously compiled component may be reused from
 *   cache. `false` in serve mode so that source and dependency edits are
 *   always reflected. Default: `true`
 */
export type CompilerFunction = (
	source: string,
	props: Record<string, unknown>,
	resolveDir: string,
	filePath: string,
	cache?: boolean,
) => Promise<string>;

/**
 * Shape a `.jsx`/`.tsx` page file's default export must satisfy
 * @template M - Custom metadata type extending MetaData
 */
export type JsxPageComponent<M extends MetaData> = (
	props: CompileData<M>,
) => ReactElement | null;

/**
 * Shape a `.jsx`/`.tsx` layout file's default export must satisfy.
 * `content` is the already-compiled HTML string of the main content,
 * meant to be embedded via `dangerouslySetInnerHTML`
 * @template M - Custom metadata type extending MetaData
 */
export type JsxLayoutComponent<M extends MetaData> = (
	props: CompileData<M> & { readonly content: string },
) => ReactElement | null;
