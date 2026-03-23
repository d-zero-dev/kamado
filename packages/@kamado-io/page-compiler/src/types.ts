import type { BreadcrumbItem } from './features/breadcrumbs.js';
import type { GetNavTreeOptions, NavNode } from './features/nav.js';
import type { TitleListOptions } from './features/title-list.js';
import type { PathListToTreeOptions } from '@d-zero/shared/path-list-to-tree';
import type { Transform } from 'kamado/config';
import type { CompilableFile, FileObject, MetaData } from 'kamado/files';

/**
 * Options for the page compiler
 * @template M - Custom metadata type extending MetaData
 */
export interface PageCompilerOptions<M extends MetaData> {
	/**
	 * Global data configuration
	 */
	readonly globalData?: {
		/**
		 * Directory path where global data files are stored
		 */
		readonly dir?: string;
		/**
		 * Additional global data
		 */
		readonly data?: Record<string, unknown>;
	};
	/**
	 * Layout file configuration
	 */
	readonly layouts?: {
		/**
		 * Directory path where layout files are stored
		 */
		readonly dir?: string;
		/**
		 * Map of layout files
		 */
		readonly files?: Record<string, FileObject>;
		/**
		 * @default 'content'
		 * @description The variable name to use for the content in the layout.
		 * @example
		 * ```pug
		 * html
		 *   body
		 *     main !{content}
		 * ```
		 */
		readonly contentVariableName?: string;
	};
	/**
	 * Array of transform functions to apply to compiled HTML, or a function that receives and returns transforms
	 * If omitted, uses createDefaultPageTransforms()
	 * @example
	 * ```typescript
	 * import { createDefaultPageTransforms } from '@kamado-io/page-compiler';
	 * import { manipulateDOM } from '@kamado-io/page-compiler/transform/manipulate-dom';
	 * import { prettier } from '@kamado-io/page-compiler/transform/prettier';
	 *
	 * // Use defaults
	 * createPageCompiler()({ transforms: createDefaultPageTransforms() });
	 *
	 * // Custom selection
	 * createPageCompiler()({
	 *   transforms: [
	 *     manipulateDOM({ imageSizes: true }),
	 *     prettier({ options: { printWidth: 120 } }),
	 *   ],
	 * });
	 *
	 * // Extend defaults with custom transform (requires import)
	 * const defaults = createDefaultPageTransforms();
	 * createPageCompiler()({
	 *   transforms: [
	 *     {
	 *       name: 'custom',
	 *       transform: (content, ctx) => {
	 *         // Custom processing
	 *         return content;
	 *       },
	 *     },
	 *     ...defaults,
	 *   ],
	 * });
	 *
	 * // Use function to extend defaults (no import needed)
	 * createPageCompiler()({
	 *   transforms: (defaults) => [
	 *     {
	 *       name: 'prepend-transform',
	 *       transform: (content) => content,
	 *     },
	 *     ...defaults,
	 *     {
	 *       name: 'append-transform',
	 *       transform: (content) => content,
	 *     },
	 *   ],
	 * });
	 * ```
	 */
	readonly transforms?:
		| Transform<M>[]
		| ((defaultTransforms: readonly Transform<M>[]) => Transform<M>[]);
	/**
	 * Compilation hooks for customizing compile process
	 * Can be an object or a function that returns an object
	 */
	readonly compileHooks?: CompileHooks<M>;
	/**
	 * Transform each breadcrumb item
	 * @param item - Original breadcrumb item (includes `meta` with page metadata)
	 * @returns Transformed breadcrumb item (can include additional properties)
	 * @example
	 * ```typescript
	 * createPageCompiler()({
	 *   transformBreadcrumbItem: (item) => ({
	 *     ...item,
	 *     href: item.meta.redirectUrl ?? item.href,
	 *     icon: item.href === '/' ? 'home' : 'page',
	 *   }),
	 * });
	 * ```
	 */
	readonly transformBreadcrumbItem?: (item: BreadcrumbItem<M>) => BreadcrumbItem<M>;
	/**
	 * Filter navigation nodes
	 *
	 * Return `true` to keep the node, `false` to remove it from the tree.
	 * @param node - Navigation node to filter
	 * @returns Whether to keep the node
	 * @example
	 * ```typescript
	 * createPageCompiler()({
	 *   filterNavigationNode: (node) => !node.url.includes('/drafts/'),
	 * });
	 * ```
	 */
	readonly filterNavigationNode?: (node: NavNode<M>) => boolean;
	/**
	 * Sort comparator for the navigation path list.
	 * - `'path'`: use pathComparator
	 * - function: custom comparator `(a, b) => number`
	 * - `null` (default): no sorting (preserve original order)
	 * @example
	 * ```typescript
	 * createPageCompiler()({
	 *   navigationComparator: 'path',
	 * });
	 * ```
	 * @example
	 * ```typescript
	 * createPageCompiler()({
	 *   navigationComparator: (a, b) => b.localeCompare(a),
	 * });
	 * ```
	 */
	readonly navigationComparator?: PathListToTreeOptions['comparator'];
}

/**
 * Compile data object passed to templates and hooks
 * @template M - Custom metadata type extending MetaData
 */
export interface CompileData<M extends MetaData> extends Record<string, unknown> {
	/**
	 * Current page file
	 */
	readonly page: CompilableFile;
	/**
	 * Navigation tree function
	 */
	readonly nav: (options: GetNavTreeOptions<M>) => NavNode<M> | null | undefined;
	/**
	 * Title list function
	 */
	readonly titleList: (options: TitleListOptions) => unknown;
	/**
	 * Breadcrumbs array
	 */
	readonly breadcrumbs: BreadcrumbItem<M>[];
}

/**
 * Hook function type for processing content
 * @template M - Custom metadata type extending MetaData
 * @param content - Template content or compiled HTML to process
 * @param data - Compile data object containing page info, navigation, and breadcrumbs
 * @returns Processed content string (sync or async)
 */
export type ContentHook<M extends MetaData> = (
	content: string,
	data: CompileData<M>,
) => Promise<string> | string;

/**
 * Compiler function type
 * @template M - Custom metadata type extending MetaData
 * @param content - Template content to compile
 * @param data - Compile data object containing page info, navigation, and breadcrumbs
 * @param extension - File extension of the source file (e.g., `.pug`, `.html`)
 * @returns Compiled HTML string (sync or async)
 */
export type CompilerFunction<M extends MetaData> = (
	content: string,
	data: CompileData<M>,
	extension: string,
) => Promise<string> | string;

/**
 * Compile hook configuration
 * @template M - Custom metadata type extending MetaData
 */
export interface CompileHook<M extends MetaData> {
	/**
	 * Hook called before compilation
	 * @param content - Template content
	 * @param data - Compile data object
	 * @returns Processed content (can be modified)
	 */
	readonly before?: ContentHook<M>;
	/**
	 * Hook called after compilation
	 * @param html - Compiled HTML
	 * @param data - Compile data object
	 * @returns Processed HTML (can be modified)
	 */
	readonly after?: ContentHook<M>;
	/**
	 * Custom compiler function
	 * @param content - Template content
	 * @param data - Compile data object
	 * @returns Compiled HTML
	 */
	readonly compiler?: CompilerFunction<M>;
}

/**
 * Compile hooks object
 * @template M - Custom metadata type extending MetaData
 */
export interface CompileHooksObject<M extends MetaData> {
	/**
	 * Hooks for main content compilation
	 */
	readonly main?: CompileHook<M>;
	/**
	 * Hooks for layout compilation
	 */
	readonly layout?: CompileHook<M>;
}

/**
 * Compilation hooks for customizing compile process
 * Can be an object or a function that returns an object (sync or async)
 * @template M - Custom metadata type extending MetaData
 */
export type CompileHooks<M extends MetaData> =
	| CompileHooksObject<M>
	| ((
			options: PageCompilerOptions<M>,
	  ) => CompileHooksObject<M> | Promise<CompileHooksObject<M>>);

/**
 * File path information
 */
export interface Paths {
	/**
	 * Output file path
	 */
	readonly filePath: string;
	/**
	 * Output file directory path
	 */
	readonly dirPath: string;
	/**
	 * Relative path from base directory ('.' if dirPath equals base directory)
	 */
	readonly relativePathFromBase: string;
}
