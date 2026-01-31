import type { PageCompilerOptions } from './types.js';
import type { CompileFunction } from 'kamado/compiler';
import type { Context } from 'kamado/config';

import { beforeSerialize } from './format/before-serialize.js';
import { buildTransformContext } from './format/build-transform-context.js';
import { characterEntities } from './format/character-entities.js';
import { doctype } from './format/doctype.js';
import { domSerialize } from './format/dom-serialize.js';
import { lineBreak } from './format/line-break.js';
import { minifier } from './format/minifier.js';
import { prettier } from './format/prettier.js';
import { replace } from './format/replace.js';

/**
 * Required context for HTML formatting
 */
export interface FormatHtmlContext {
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
	 * Kamado context (needed for TransformContext)
	 */
	readonly context: Context;
	/**
	 * Compile function for compiling other files during HTML formatting.
	 * Used when the formatter needs to compile dependencies (e.g., layouts, includes).
	 */
	readonly compile: CompileFunction;
}

/**
 * Optional options for HTML formatting
 */
export interface FormatHtmlOptions {
	/**
	 * Hook function called before DOM serialization
	 */
	readonly beforeSerialize?: PageCompilerOptions['beforeSerialize'];
	/**
	 * Hook function called after DOM serialization
	 */
	readonly afterSerialize?: PageCompilerOptions['afterSerialize'];
	/**
	 * JSDOM URL configuration (optional)
	 */
	readonly url?: string;
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
 * @param context - Required context (content, inputPath, outputPath, outputDir, context, compile)
 * @param options - Optional options (beforeSerialize, afterSerialize, url, imageSizes, etc.)
 * @returns Formatted HTML content or ArrayBuffer
 */
export async function formatHtml(
	context: FormatHtmlContext,
	options?: FormatHtmlOptions,
): Promise<string | ArrayBuffer> {
	const {
		content: initialContent,
		inputPath,
		outputPath,
		outputDir,
		context: kamadoContext,
		compile,
	} = context;
	const { isServe = false } = options ?? {};

	// Build TransformContext for hooks
	const transformContext = buildTransformContext(
		{ outputPath, outputDir, inputPath, kamadoContext },
		{ isServe },
	);

	// Apply transformations sequentially using a pipeline
	let content: string | ArrayBuffer = initialContent;

	for (const processor of [
		beforeSerialize(
			{ transformContext, compile },
			{ beforeSerialize: options?.beforeSerialize, isServe },
		),
		domSerialize(
			{ outputDir, transformContext, compile },
			{
				imageSizes: options?.imageSizes,
				afterSerialize: options?.afterSerialize,
				url: options?.url,
				isServe,
			},
		),
		characterEntities({ enabled: options?.characterEntities }),
		doctype(),
		prettier({ inputPath }, { prettier: options?.prettier }),
		minifier({ minifier: options?.minifier }),
		lineBreak({ lineBreak: options?.lineBreak }),
		replace({ outputPath, outputDir }, { replace: options?.replace, isServe }),
	]) {
		content = await processor(content);
	}

	return content;
}
