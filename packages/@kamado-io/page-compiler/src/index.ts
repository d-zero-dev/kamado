import type { BreadcrumbItem } from './features/breadcrumbs.js';
import type { GetNavTreeOptions, NavNode } from './features/nav.js';
import type { TitleListOptions } from './features/title-list.js';
import type { Options as HMTOptions } from 'html-minifier-terser';
import type { Config } from 'kamado/config';
import type { CompilableFile, FileObject } from 'kamado/files';
import type { Options as PrettierOptions } from 'prettier';

import path from 'node:path';

import c from 'ansi-colors';
import { createCompiler } from 'kamado/compiler';
import { getGlobalData } from 'kamado/data';

import { getBreadcrumbs } from './features/breadcrumbs.js';
import { getNavTree } from './features/nav.js';
import { titleList } from './features/title-list.js';
import { formatHtml } from './format.js';
import { type ImageSizesOptions } from './image.js';
import { getLayouts } from './layouts.js';
import { transpileLayout } from './transpile-layout.js';
import { transpileMainContent } from './transpile-main.js';

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
	 * @returns Processed HTML content
	 */
	readonly beforeSerialize?: (
		content: string,
		isServe: boolean,
	) => Promise<string> | string;
	/**
	 * Hook function called after DOM serialization
	 * @param elements - Array of DOM elements
	 * @param window - Window object
	 * @param isServe - Whether running on development server
	 */
	readonly afterSerialize?: (
		elements: readonly Element[],
		window: Window,
		isServe: boolean,
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

/**
 * Page compiler
 * A generic container compiler that applies layouts and formats the output.
 * Template compilation is handled via `compileHooks`.
 * @example
 * ```typescript
 * const config = {
 *   compilers: [
 *     pageCompiler({
 *       layouts: { dir: './layouts' },
 *       globalData: { dir: './data' },
 *       imageSizes: true,
 *     }),
 *   ],
 * };
 * ```
 * @throws {Error} if page compilation fails or layout is not found
 */
export const pageCompiler = createCompiler<PageCompilerOptions>(() => ({
	defaultFiles: '**/*.html',
	defaultOutputExtension: '.html',
	compile: (options) => async (config: Config) => {
		const layoutsFromDir = await getLayouts({
			dir: options?.layouts?.dir,
		});
		const layouts = {
			...layoutsFromDir,
			...options?.layouts?.files,
		};

		const globalDataFromDir = options?.globalData?.dir
			? await getGlobalData(options?.globalData?.dir, config)
			: undefined;
		const globalData = {
			...globalDataFromDir,
			...options?.globalData?.data,
		};

		return async (
			file: CompilableFile,
			log?: (message: string) => void,
			cache?: boolean,
		) => {
			log?.(c.blue('Building...'));
			const pageContent = await file.get(cache);
			const { metaData, content: pageMainContent } = pageContent;

			const breadcrumbs = getBreadcrumbs(file, globalData?.pageList ?? [], {
				baseURL: config.pkg.production?.baseURL,
				optimizeTitle: options?.optimizeTitle,
				transformItem: options?.transformBreadcrumbItem,
			});

			const compileData: CompileData = {
				...globalData,
				...metaData,
				page: file,
				nav: (navOptions: GetNavTreeOptions) =>
					getNavTree(file, globalData?.pageList ?? [], {
						optimizeTitle: options?.optimizeTitle,
						...navOptions,
						transformNode: options?.transformNavNode,
					}),
				titleList: (options: TitleListOptions) =>
					titleList(breadcrumbs, {
						siteName: config.pkg.production?.siteName,
						...options,
					}),
				breadcrumbs,
			};

			// Resolve compileHooks (can be object or function)
			const compileHooks =
				typeof options?.compileHooks === 'function'
					? await options.compileHooks(options)
					: options?.compileHooks;

			// Transpile main content
			const mainContentHtml = await transpileMainContent(
				pageMainContent,
				compileData,
				file,
				compileHooks?.main,
				log,
			);

			let html = mainContentHtml;

			// Apply layout if specified
			if (metaData?.layout) {
				const layout = layouts[metaData.layout as string];
				if (!layout) {
					throw new Error(`Layout not found: ${metaData.layout}`);
				}

				const { content: layoutContent } = await layout.get(cache);
				const contentVariableName = options?.layouts?.contentVariableName ?? 'content';
				const layoutCompileData: CompileData = {
					...compileData,
					[contentVariableName]: mainContentHtml,
				};
				const layoutExtension = path.extname(layout.inputPath).toLowerCase();

				// Transpile layout
				html = await transpileLayout(
					layoutContent,
					layoutCompileData,
					layoutExtension,
					layout,
					file,
					compileHooks?.layout,
					log,
				);
			}

			log?.(c.cyanBright('Formatting...'));
			const formattedHtml = await formatHtml({
				content: html,
				inputPath: file.inputPath,
				outputPath: file.outputPath,
				outputDir: config.dir.output,
				devServerHost: config.devServer.host,
				devServerPort: config.devServer.port,
				productionBaseURL: config.pkg.production?.baseURL,
				productionHost: config.pkg.production?.host,
				beforeSerialize: options?.beforeSerialize,
				afterSerialize: options?.afterSerialize,
				host: options?.host,
				imageSizes: options?.imageSizes,
				characterEntities: options?.characterEntities,
				prettier: options?.prettier,
				minifier: options?.minifier,
				lineBreak: options?.lineBreak,
				replace: options?.replace,
				isServe: false,
			});

			return formattedHtml;
		};
	},
}));

// Re-export for backward compatibility
export { getLayouts, type GetLayoutsOptions } from './layouts.js';
