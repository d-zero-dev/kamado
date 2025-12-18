import type { Options as HMTOptions } from 'html-minifier-terser';
import type { Config } from 'kamado/config';
import type { GetNavTreeOptions, TitleListOptions } from 'kamado/features';
import type { CompilableFile, FileObject } from 'kamado/files';
import type { Options as PrettierOptions } from 'prettier';

import path from 'node:path';

import c from 'ansi-colors';
import { characterEntities } from 'character-entities';
import fg from 'fast-glob';
import { minify } from 'html-minifier-terser';
import { createCompiler } from 'kamado/compiler';
import { getGlobalData } from 'kamado/data';
import { getBreadcrumbs, getNavTree, titleList } from 'kamado/features';
import { getFileContent } from 'kamado/files';
import { domSerialize } from 'kamado/utils/dom';
import {
	format as prettierFormat,
	resolveConfig as prettierResolveConfig,
} from 'prettier';

import { imageSizes, type ImageSizesOptions } from './image.js';

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
	readonly nav: (options: GetNavTreeOptions) => unknown;
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

			const breadcrumbs = await getBreadcrumbs(file, globalData?.allPages ?? [], {
				baseURL: config.pkg.production?.baseURL,
				optimizeTitle: options?.optimizeTitle,
			});

			const compileData: CompileData = {
				...globalData,
				...metaData,
				page: file,
				nav: (navOptions: GetNavTreeOptions) =>
					getNavTree(
						file,
						globalData?.pageList ?? [],
						options?.optimizeTitle,
						navOptions,
					),
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

			let mainContentHtml = pageMainContent;

			// Apply compileHooks for main content (extension-independent)
			if (compileHooks?.main) {
				try {
					let content = pageMainContent;

					// Apply before hook
					if (compileHooks.main.before) {
						content = await compileHooks.main.before(content, compileData);
					}

					// Compile
					if (compileHooks.main.compiler) {
						log?.(c.yellowBright('Compiling main content...'));
						mainContentHtml = await compileHooks.main.compiler(
							content,
							compileData,
							file.extension,
						);
					}
					// If no compiler is specified, pass through as-is

					// Apply after hook
					if (compileHooks.main.after) {
						mainContentHtml = await compileHooks.main.after(mainContentHtml, compileData);
					}
				} catch (error) {
					log?.(c.red(`❌ ${file.inputPath}`));
					throw new Error(`Failed to compile the page: ${file.inputPath}`, {
						cause: error,
					});
				}
			}

			let html = mainContentHtml;

			if (metaData?.layout) {
				const layout = layouts[metaData.layout as string];
				if (!layout) {
					throw new Error(`Layout not found: ${metaData.layout}`);
				}

				const { content: layoutContent } = await layout.get();
				const contentVariableName = options?.layouts?.contentVariableName ?? 'content';
				const layoutCompileData: CompileData = {
					...compileData,
					[contentVariableName]: mainContentHtml,
				};

				// Apply compileHooks for layout (extension-independent)
				if (compileHooks?.layout) {
					try {
						let content = layoutContent;

						// Apply before hook
						if (compileHooks.layout.before) {
							content = await compileHooks.layout.before(content, layoutCompileData);
						}

						// Compile
						if (compileHooks.layout.compiler) {
							log?.(c.greenBright('Compiling layout...'));
							const layoutExtension = path.extname(layout.inputPath).toLowerCase();
							html = await compileHooks.layout.compiler(
								content,
								layoutCompileData,
								layoutExtension,
							);
						} else {
							// If no compiler is specified, use layout content as-is
							html = content;
						}

						// Apply after hook
						if (compileHooks.layout.after) {
							html = await compileHooks.layout.after(html, layoutCompileData);
						}
					} catch (error) {
						log?.(c.red(`❌ Layout: ${layout.inputPath} (Content: ${file.inputPath})`));
						throw new Error(`Failed to compile the layout: ${layout.inputPath}`, {
							cause: error,
						});
					}
				} else {
					// If no compileHooks.layout, use layout content as-is
					html = layoutContent;
				}
			}

			log?.(c.cyanBright('Formatting...'));
			const formattedHtml = await formatHtml(
				html,
				file.inputPath,
				file.outputPath,
				config,
				options,
				false,
			);

			return formattedHtml;
		};
	},
}));

/**
 * Formats HTML content
 * @param content - HTML content to format
 * @param inputPath - Input file path
 * @param outputPath - Output file path
 * @param config - Configuration object
 * @param options - Page compiler options
 * @param isServe - Whether running on development server
 * @returns Formatted HTML content or ArrayBuffer
 */
async function formatHtml(
	content: string,
	inputPath: string,
	outputPath: string,
	config: Config,
	options?: PageCompilerOptions,
	isServe: boolean = false,
): Promise<string | ArrayBuffer> {
	if (options?.beforeSerialize) {
		content = await options.beforeSerialize(content, isServe);
	}

	// Determine URL for JSDOM
	let jsdomUrl: string | undefined;
	if (options?.host) {
		jsdomUrl = options.host;
	} else if (isServe) {
		jsdomUrl = `http://${config.devServer.host}:${config.devServer.port}`;
	} else {
		jsdomUrl =
			config.pkg.production?.baseURL ??
			(config.pkg.production?.host ? `http://${config.pkg.production.host}` : undefined);
	}

	const imageSizesOption = options?.imageSizes ?? true;
	if (imageSizesOption || options?.afterSerialize) {
		content = await domSerialize(
			content,
			async (elements, window) => {
				// Hooks
				if (imageSizesOption) {
					const options = typeof imageSizesOption === 'object' ? imageSizesOption : {};
					const rootDir = path.resolve(config.dir.output);
					await imageSizes(elements, {
						rootDir,
						...options,
					});
				}

				await options?.afterSerialize?.(elements, window, isServe);
			},
			jsdomUrl,
		);
	}

	if (options?.characterEntities) {
		for (const [entity, char] of Object.entries(characterEntities)) {
			let _entity = entity;
			const codePoint = char.codePointAt(0);
			if (codePoint != null && codePoint < 127) {
				continue;
			}
			if (/^[A-Z]+$/i.test(entity) && characterEntities[entity.toLowerCase()] === char) {
				_entity = entity.toLowerCase();
			}
			content = content.replaceAll(char, `&${_entity};`);
		}
	}

	if (
		// Start with `<html` (For partial HTML)
		/^<html(?:\s|>)/i.test(content.trim()) &&
		// Not start with `<!doctype html`
		!/^<!doctype html/i.test(content.trim())
	) {
		// eleventy-pug-plugin does not support `doctype` option
		content = '<!DOCTYPE html>\n' + content;
	}

	if (options?.prettier ?? true) {
		const userPrettierConfig =
			typeof options?.prettier === 'object' ? options.prettier : {};
		const prettierConfig = await prettierResolveConfig(inputPath);
		content = await prettierFormat(content, {
			parser: 'html',
			printWidth: 100_000,
			tabWidth: 2,
			useTabs: false,
			...prettierConfig,
			...userPrettierConfig,
		});
	}

	if (options?.minifier ?? true) {
		content = await minify(content, {
			collapseWhitespace: false,
			collapseBooleanAttributes: true,
			removeComments: false,
			removeRedundantAttributes: true,
			removeScriptTypeAttributes: true,
			removeStyleLinkTypeAttributes: true,
			useShortDoctype: false,
			minifyCSS: true,
			minifyJS: true,
			...options?.minifier,
		});
	}

	if (options?.lineBreak) {
		content = content.replaceAll(/\r?\n/g, options.lineBreak);
	}

	if (options?.replace) {
		const filePath = outputPath;
		const dirPath = path.dirname(filePath);
		const relativePathFromBase = path.relative(dirPath, config.dir.output) || '.';

		content = await options.replace(
			content,
			{
				filePath,
				dirPath,
				relativePathFromBase,
			},
			false,
		);
	}

	return content;
}

interface GetLayoutsOptions {
	dir?: string;
}

/**
 * Gets layout files
 * @param options - Options for getting layouts
 * @param options.dir - Directory path where layout files are stored
 * @returns Map of layout files (empty object if dir is not provided)
 */
export async function getLayouts(options: GetLayoutsOptions) {
	if (!options.dir) {
		return {};
	}

	const layoutsFilePaths = await fg(path.resolve(options.dir, '*'));
	let layouts: Record<string, FileObject> = {};
	for (const layoutsFilePath of layoutsFilePaths) {
		layouts = {
			...layouts,
			...getLayout(layoutsFilePath),
		};
	}
	return layouts;
}

/**
 * Gets a single layout file
 * @param filePath - Path to the layout file
 * @returns Object containing the layout file (keyed by filename)
 */
function getLayout(filePath: string): Record<string, FileObject> {
	const name = path.basename(filePath);
	return {
		[name]: {
			inputPath: filePath,
			async get() {
				const content = await getFileContent(filePath);
				return {
					metaData: {},
					content,
					raw: content,
				};
			},
		},
	};
}
