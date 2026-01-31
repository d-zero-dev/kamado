import type { BreadcrumbItem } from './features/breadcrumbs.js';
import type { GetNavTreeOptions, NavNode } from './features/nav.js';
import type { TitleListOptions } from './features/title-list.js';
import type { ImageSizesOptions } from './image.js';
import type { Options as HMTOptions } from 'html-minifier-terser';
import type { CompileFunction } from 'kamado/compiler';
import type { TransformContext } from 'kamado/config';
import type { CompilableFile, FileObject } from 'kamado/files';
import type { Options as PrettierOptions } from 'prettier';

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
	 * Configuration for automatically adding width/height attributes to images
	 * @default true
	 */
	readonly imageSizes?: ImageSizesOptions | boolean;
	/**
	 * HTML minifier options
	 * @default true
	 */
	readonly minifier?: HMTOptions;
	/**
	 * Prettier options
	 * @default true
	 */
	readonly prettier?: PrettierOptions | boolean;
	/**
	 * Line break configuration
	 */
	readonly lineBreak?: '\n' | '\r\n';
	/**
	 * Whether to enable character entity conversion
	 */
	readonly characterEntities?: boolean;
	/**
	 * Function to optimize titles
	 */
	readonly optimizeTitle?: (title: string) => string;
	/**
	 * JSDOM URL configuration
	 * Host URL to use for JSDOM's url option
	 * If not specified, will use production domain from package.json in build mode,
	 * or dev server URL in serve mode
	 */
	readonly host?: string;
	/**
	 * Hook function called before DOM serialization
	 * @param content - HTML content
	 * @param isServe - Whether running on development server
	 * @param context - Transform context (provides path and config info)
	 * @returns Processed HTML content
	 */
	readonly beforeSerialize?: (
		content: string,
		isServe: boolean,
		context: TransformContext,
		compile: CompileFunction,
	) => Promise<string> | string;
	/**
	 * Hook function called after DOM serialization
	 * @param elements - Array of DOM elements
	 * @param window - Window object
	 * @param isServe - Whether running on development server
	 * @param context - Transform context (provides path and config info)
	 */
	readonly afterSerialize?: (
		elements: readonly Element[],
		window: Window,
		isServe: boolean,
		context: TransformContext,
		compile: CompileFunction,
	) => Promise<void> | void;
	/**
	 * Final HTML content replacement processing
	 * @param content - HTML content
	 * @param paths - Path information
	 * @param isServe - Whether running on development server
	 * @returns Replaced HTML content
	 */
	readonly replace?: (
		content: string,
		paths: Paths,
		isServe: boolean,
	) => Promise<string> | string;
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
 * Options for getting page title
 */
export interface GetTitleOptions {
	/**
	 * Function to optimize title (optional)
	 */
	readonly optimizeTitle?: (title: string) => string;
	/**
	 * Whether to return an empty string if the page content is not found (optional)
	 */
	readonly safe?: boolean;
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
