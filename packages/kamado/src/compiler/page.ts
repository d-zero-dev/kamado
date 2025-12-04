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

export interface PageCompilerOptions {
	readonly globalData?: {
		readonly dir?: string;
		readonly data?: Record<string, unknown>;
	};
	readonly layouts?: {
		readonly dir?: string;
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
	readonly pathAlias?: string;
	readonly imageSizes?: ImageSizesOptions | boolean;
	readonly minifier?: HMTOptions;
	readonly prettier?: PrettierOptions | boolean;
	readonly lineBreak?: '\n' | '\r\n';
	readonly characterEntities?: boolean;
	readonly optimizeTitle?: (title: string) => string;
	readonly beforeSerialize?: (
		content: string,
		isServe: boolean,
	) => Promise<string> | string;
	readonly afterSerialize?: (
		elements: readonly Element[],
		window: Window,
		isServe: boolean,
	) => Promise<void> | void;
	readonly replace?: (
		content: string,
		paths: Paths,
		isServe: boolean,
	) => Promise<string> | string;
}

export interface ImageSizesOptions {
	readonly rootDir?: string;
	readonly selector?: string;
	readonly ext?: readonly string[];
}

export interface Paths {
	readonly filePath: string;
	readonly dirPath: string;
	readonly relativePathFromBase: string;
}

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
 *
 * @param content
 * @param inputPath
 * @param outputPath
 * @param config
 * @param options
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
 *
 * @param options
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
 *
 * @param filePath
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
