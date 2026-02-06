import type { BreadcrumbItem } from './features/breadcrumbs.js';
import type { GetNavTreeOptions, NavNode } from './features/nav.js';
import type { TitleListOptions } from './features/title-list.js';
import type { Transform } from 'kamado/config';
import type { CompilableFile, FileObject } from 'kamado/files';

/**
 * Options for the page compiler
 */
export interface PageCompilerOptions {
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
	 * If omitted, uses defaultPageTransforms
	 * @example
	 * ```typescript
	 * import { defaultPageTransforms } from '@kamado-io/page-compiler/page-transform';
	 * import { manipulateDOM } from '@kamado-io/page-compiler/transform/manipulate-dom';
	 * import { prettier } from '@kamado-io/page-compiler/transform/prettier';
	 *
	 * // Use defaults
	 * pageCompiler({ transforms: defaultPageTransforms });
	 *
	 * // Custom selection
	 * pageCompiler({
	 *   transforms: [
	 *     manipulateDOM({ imageSizes: true }),
	 *     prettier({ options: { printWidth: 120 } }),
	 *   ],
	 * });
	 *
	 * // Extend defaults with custom transform (requires import)
	 * pageCompiler({
	 *   transforms: [
	 *     {
	 *       name: 'custom',
	 *       transform: (content, ctx) => {
	 *         // Custom processing
	 *         return content;
	 *       },
	 *     },
	 *     ...defaultPageTransforms,
	 *   ],
	 * });
	 *
	 * // Use function to extend defaults (no import needed)
	 * pageCompiler({
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
		| Transform[]
		| ((defaultTransforms: readonly Transform[]) => Transform[]);
	/**
	 * Compilation hooks for customizing compile process
	 * Can be an object or a function that returns an object
	 */
	readonly compileHooks?: CompileHooks;
	/**
	 * Transform each breadcrumb item
	 * @param item - Original breadcrumb item
	 * @returns Transformed breadcrumb item (can include additional properties)
	 * @example
	 * ```typescript
	 * pageCompiler({
	 *   transformBreadcrumbItem: (item) => ({
	 *     ...item,
	 *     icon: item.href === '/' ? 'home' : 'page',
	 *   }),
	 * });
	 * ```
	 */
	readonly transformBreadcrumbItem?: (item: BreadcrumbItem) => BreadcrumbItem;
	/**
	 * Transform each navigation node
	 * @param node - Original navigation node
	 * @returns Transformed navigation node (can include additional properties, or null/undefined to remove the node)
	 * @example
	 * ```typescript
	 * pageCompiler({
	 *   transformNavNode: (node) => {
	 *     return { ...node, badge: 'new' };
	 *   },
	 * });
	 * ```
	 */
	readonly transformNavNode?: (node: NavNode) => NavNode | null | undefined;
}

/**
 * Compile data object passed to templates and hooks
 */
export interface CompileData extends Record<string, unknown> {
	/**
	 * Current page file
	 */
	readonly page: CompilableFile;
	/**
	 * Navigation tree function
	 */
	readonly nav: (options: GetNavTreeOptions) => NavNode | null | undefined;
	/**
	 * Title list function
	 */
	readonly titleList: (options: TitleListOptions) => unknown;
	/**
	 * Breadcrumbs array
	 */
	readonly breadcrumbs: unknown;
}

/**
 * Hook function type for processing content
 */
export type ContentHook = (
	content: string,
	data: CompileData,
) => Promise<string> | string;

/**
 * Compiler function type
 */
export type CompilerFunction = (
	content: string,
	data: CompileData,
	extension: string,
) => Promise<string> | string;

/**
 * Compile hook configuration
 */
export interface CompileHook {
	/**
	 * Hook called before compilation
	 * @param content - Template content
	 * @param data - Compile data object
	 * @returns Processed content (can be modified)
	 */
	readonly before?: ContentHook;
	/**
	 * Hook called after compilation
	 * @param html - Compiled HTML
	 * @param data - Compile data object
	 * @returns Processed HTML (can be modified)
	 */
	readonly after?: ContentHook;
	/**
	 * Custom compiler function
	 * @param content - Template content
	 * @param data - Compile data object
	 * @returns Compiled HTML
	 */
	readonly compiler?: CompilerFunction;
}

/**
 * Compile hooks object
 */
export interface CompileHooksObject {
	/**
	 * Hooks for main content compilation
	 */
	readonly main?: CompileHook;
	/**
	 * Hooks for layout compilation
	 */
	readonly layout?: CompileHook;
}

/**
 * Compilation hooks for customizing compile process
 * Can be an object or a function that returns an object (sync or async)
 */
export type CompileHooks =
	| CompileHooksObject
	| ((options: PageCompilerOptions) => CompileHooksObject | Promise<CompileHooksObject>);

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
