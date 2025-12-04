import type { Config } from '../config/types.js';
import type { GetNavTreeOptions } from '../features/nav.js';
import type { TitleListOptions } from '../features/title-list.js';
import type { FileObject } from '../files/types.js';
import type { Options as HMTOptions } from 'html-minifier-terser';
import type { Options as PrettierOptions } from 'prettier';

import path from 'node:path';

import c from 'ansi-colors';
import { characterEntities } from 'character-entities';
import fg from 'fast-glob';
import { minify } from 'html-minifier-terser';
import {
	format as prettierFormat,
	resolveConfig as prettierResolveConfig,
} from 'prettier';
import pug from 'pug';

import { getGlobalData } from '../data/global.js';
import { getBreadcrumbs } from '../features/breadcrumbs.js';
import { imageSizes } from '../features/image.js';
import { getNavTree } from '../features/nav.js';
import { titleList } from '../features/title-list.js';
import { getFileContent } from '../files/file-content.js';
import { domSerialize } from '../utils/dom.js';

import { createCompiler } from './index.js';

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
	 * Path alias for Pug templates (used as basedir)
	 */
	readonly pathAlias?: string;
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
}

/**
 * Options for automatic image size addition
 */
export interface ImageSizesOptions {
	/**
	 * Root directory for image files
	 */
	readonly rootDir?: string;
	/**
	 * Selector for target image elements
	 */
	readonly selector?: string;
	/**
	 * List of image extensions to target
	 * @default ['png', 'jpg', 'jpeg', 'webp', 'avif', 'svg']
	 */
	readonly ext?: readonly string[];
}

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
 * Compiles Pug templates to HTML, applies layouts, and formats the output.
 * @example
 * ```typescript
 * const config = {
 *   compilers: {
 *     page: pageCompiler({
 *       layouts: { dir: './layouts' },
 *       globalData: { dir: './data' },
 *       imageSizes: true,
 *     }),
 *   },
 * };
 * ```
 * @throws Error if page compilation fails or layout is not found
 */
export const pageCompiler = createCompiler<PageCompilerOptions>(
	(options) => async (config) => {
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

		return async (file, log) => {
			log?.(c.blue('Building...'));
			const pageContent = await file.get();
			const { metaData, content: pageMainContent } = pageContent;

			const breadcrumbs = await getBreadcrumbs(file, globalData?.allPages ?? [], {
				baseURL: config.pkg.production?.baseURL,
				optimizeTitle: options?.optimizeTitle,
			});

			const pugCompilerOptions = {
				basedir: options?.pathAlias,
				doctype: 'html',
				pretty: true,
			};

			const compileData = {
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

			let mainContentHtml = pageMainContent;

			switch (file.extension) {
				case '.pug': {
					log?.(c.yellowBright('Compiling main content...'));
					try {
						const mainContentCompiler = pug.compile(pageMainContent, pugCompilerOptions);
						mainContentHtml = mainContentCompiler(compileData);
					} catch (error) {
						log?.(c.red(`❌ ${file.inputPath}`));
						throw new Error(`Failed to compile the page: ${file.inputPath}`, {
							cause: error,
						});
					}
				}
			}

			let html = mainContentHtml;

			if (metaData?.layout) {
				const layout = layouts[metaData.layout as string];
				if (layout) {
					const extension = path.extname(layout.inputPath).toLowerCase();
					switch (extension) {
						case '.pug': {
							log?.(c.greenBright('Compiling layout...'));
							const { content: layoutContent } = await layout.get();
							try {
								const contentVariableName =
									options?.layouts?.contentVariableName ?? 'content';
								const layoutCompiler = pug.compile(layoutContent, pugCompilerOptions);
								html = layoutCompiler({
									...compileData,
									[contentVariableName]: mainContentHtml,
								});
							} catch (error) {
								log?.(
									c.red(`❌ Layout: ${layout.inputPath} (Content: ${file.inputPath})`),
								);
								throw new Error(`Failed to compile the layout: ${layout.inputPath}`, {
									cause: error,
								});
							}
						}
					}
				} else {
					throw new Error(`Layout not found: ${metaData.layout}`);
				}
			}

			log?.(c.cyanBright('Formatting...'));
			const formattedHtml = await formatHtml(
				html,
				file.inputPath,
				file.outputPath,
				config,
				options,
			);

			return formattedHtml;
		};
	},
);

/**
 * Formats HTML content
 * @param content - HTML content to format
 * @param inputPath - Input file path
 * @param outputPath - Output file path
 * @param config - Configuration object
 * @param options - Page compiler options
 * @returns Formatted HTML content or ArrayBuffer
 */
async function formatHtml(
	content: string,
	inputPath: string,
	outputPath: string,
	config: Config,
	options?: PageCompilerOptions,
): Promise<string | ArrayBuffer> {
	if (options?.beforeSerialize) {
		content = await options.beforeSerialize(content, false);
	}

	const imageSizesOption = options?.imageSizes ?? true;
	if (imageSizesOption || options?.afterSerialize) {
		content = await domSerialize(content, async (elements, window) => {
			// Hooks
			if (imageSizesOption) {
				const options = typeof imageSizesOption === 'object' ? imageSizesOption : {};
				const rootDir = path.resolve(config.dir.output);
				await imageSizes(elements, {
					rootDir,
					...options,
				});
			}

			await options?.afterSerialize?.(elements, window, false);
		});
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
