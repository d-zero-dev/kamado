import type { PageCompilerOptions } from './index.js';

import path from 'node:path';

import { characterEntities } from 'character-entities';
import { minify } from 'html-minifier-terser';
import { domSerialize } from 'kamado/utils/dom';
import {
	format as prettierFormat,
	resolveConfig as prettierResolveConfig,
} from 'prettier';

import { imageSizes } from './image.js';

/**
 * Options for formatHtml function
 */
export interface FormatHtmlOptions {
	/**
	 * HTML content to format
	 */
	readonly content: string;
	/**
	 * Input file path
	 */
	readonly inputPath: string;
	/**
	 * Output file path
	 */
	readonly outputPath: string;
	/**
	 * Output directory path
	 */
	readonly outputDir: string;
	/**
	 * Development server host
	 */
	readonly devServerHost: string;
	/**
	 * Development server port
	 */
	readonly devServerPort: number;
	/**
	 * Production base URL
	 */
	readonly productionBaseURL?: string;
	/**
	 * Production host
	 */
	readonly productionHost?: string;
	/**
	 * Hook function called before DOM serialization
	 */
	readonly beforeSerialize?: PageCompilerOptions['beforeSerialize'];
	/**
	 * Hook function called after DOM serialization
	 */
	readonly afterSerialize?: PageCompilerOptions['afterSerialize'];
	/**
	 * JSDOM URL configuration
	 */
	readonly host?: string;
	/**
	 * Configuration for automatically adding width/height attributes to images
	 */
	readonly imageSizes?: PageCompilerOptions['imageSizes'];
	/**
	 * Whether to enable character entity conversion
	 */
	readonly characterEntities?: boolean;
	/**
	 * Prettier options
	 */
	readonly prettier?: PageCompilerOptions['prettier'];
	/**
	 * HTML minifier options
	 */
	readonly minifier?: PageCompilerOptions['minifier'];
	/**
	 * Line break configuration
	 */
	readonly lineBreak?: PageCompilerOptions['lineBreak'];
	/**
	 * Final HTML content replacement processing
	 */
	readonly replace?: PageCompilerOptions['replace'];
	/**
	 * Whether running on development server
	 * @default false
	 */
	readonly isServe?: boolean;
}

/**
 * Formats HTML content by applying various transformations:
 * - DOM serialization (JSDOM) for image size insertion and custom manipulations
 * - Character entity conversion
 * - DOCTYPE addition
 * - Prettier formatting
 * - HTML minification
 * - Line break normalization
 * - Custom content replacement
 * @param options - Format options
 * @returns Formatted HTML content or ArrayBuffer
 */
export async function formatHtml(
	options: FormatHtmlOptions,
): Promise<string | ArrayBuffer> {
	const {
		content: initialContent,
		inputPath,
		outputPath,
		outputDir,
		devServerHost,
		devServerPort,
		productionBaseURL,
		productionHost,
		beforeSerialize,
		afterSerialize,
		host,
		imageSizes: imageSizesOption,
		characterEntities: characterEntitiesOption,
		prettier: prettierOption,
		minifier: minifierOption,
		lineBreak: lineBreakOption,
		replace: replaceOption,
		isServe = false,
	} = options;
	let content = initialContent;
	if (beforeSerialize) {
		content = await beforeSerialize(content, isServe);
	}

	// Determine URL for JSDOM
	let jsdomUrl: string | undefined;
	if (host) {
		jsdomUrl = host;
	} else if (isServe) {
		jsdomUrl = `http://${devServerHost}:${devServerPort}`;
	} else {
		jsdomUrl =
			productionBaseURL ?? (productionHost ? `http://${productionHost}` : undefined);
	}

	const imageSizesValue = imageSizesOption ?? true;
	if (imageSizesValue || afterSerialize) {
		content = await domSerialize(
			content,
			async (elements, window) => {
				// Hooks
				if (imageSizesValue) {
					const imageSizeOpts =
						typeof imageSizesValue === 'object' ? imageSizesValue : {};
					const rootDir = path.resolve(outputDir);
					await imageSizes(elements, {
						rootDir,
						...imageSizeOpts,
					});
				}

				await afterSerialize?.(elements, window, isServe);
			},
			jsdomUrl,
		);
	}

	if (characterEntitiesOption) {
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

	if (prettierOption ?? true) {
		const userPrettierConfig = typeof prettierOption === 'object' ? prettierOption : {};
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

	if (minifierOption ?? true) {
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
			...minifierOption,
		});
	}

	if (lineBreakOption) {
		content = content.replaceAll(/\r?\n/g, lineBreakOption);
	}

	if (replaceOption) {
		const filePath = outputPath;
		const dirPath = path.dirname(filePath);
		const relativePathFromBase = path.relative(dirPath, outputDir) || '.';

		content = await replaceOption(
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
