import type { PageCompilerOptions } from './index.js';
import type { Config } from 'kamado/config';

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
 * Formats HTML content by applying various transformations:
 * - DOM serialization (JSDOM) for image size insertion and custom manipulations
 * - Character entity conversion
 * - DOCTYPE addition
 * - Prettier formatting
 * - HTML minification
 * - Line break normalization
 * - Custom content replacement
 * @param content - HTML content to format
 * @param inputPath - Input file path
 * @param outputPath - Output file path
 * @param config - Configuration object
 * @param options - Page compiler options
 * @param isServe - Whether running on development server
 * @returns Formatted HTML content or ArrayBuffer
 */
export async function formatHtml(
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
