import type { PageCompilerOptions } from './types.js';
import type { CompileFunction } from 'kamado/compiler';
import type { Context } from 'kamado/config';

import { buildTransformContext } from './format/build-transform-context.js';
import { characterEntities } from './format/character-entities.js';
import { doctype } from './format/doctype.js';
import { lineBreak } from './format/line-break.js';
import { manipulateDOM } from './format/manipulate-dom.js';
import { minifier } from './format/minifier.js';
import { postprocessContent } from './format/postprocess-content.js';
import { preprocessContent } from './format/preprocess-content.js';
import { prettier } from './format/prettier.js';

/**
 * Required context for page transformation
 */
export interface PageTransformContext {
	/**
	 * HTML content to transform
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
	 * Compile function for compiling other files during page transformation.
	 * Used when the transformer needs to compile dependencies (e.g., layouts, includes).
	 */
	readonly compile: CompileFunction;
}

/**
 * Optional options for page transformation
 */
export interface PageTransformOptions {
	// Phase 1: preprocessContent (DOM parsing前のコンテンツ前処理)
	/**
	 * Hook function called for preprocessing content before DOM parsing
	 */
	readonly preprocessContent?: PageCompilerOptions['preprocessContent'];

	// Phase 2: manipulateDOM (DOM操作)
	/**
	 * Configuration for automatically adding width/height attributes to images
	 */
	readonly imageSizes?: PageCompilerOptions['imageSizes'];
	/**
	 * Hook function called for DOM manipulation after parsing
	 */
	readonly manipulateDOM?: PageCompilerOptions['manipulateDOM'];
	/**
	 * JSDOM URL configuration (optional)
	 */
	readonly url?: string;

	// Phase 3: postprocessContent (DOM serialization後のコンテンツ後処理)
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
	 * Hook function called for postprocessing content after DOM serialization
	 */
	readonly postprocessContent?: PageCompilerOptions['postprocessContent'];

	// Common
	/**
	 * Whether running on development server
	 * @default false
	 */
	readonly isServe?: boolean;
}

/**
 * Transforms page content by applying a three-phase transformation pipeline:
 *
 * Phase 1 (preprocessContent): String transformations before DOM parsing
 * - preprocessContent: User-defined pre-DOM hook for content preprocessing
 *
 * Phase 2 (manipulateDOM): DOM-based transformations
 * - manipulateDOM: DOM parsing, image size injection, manipulateDOM hook
 *
 * Phase 3 (postprocessContent): String transformations after DOM serialization
 * - characterEntities: Convert characters to HTML entities
 * - doctype: Insert DOCTYPE declaration
 * - prettier: Format with Prettier
 * - minifier: Minify HTML
 * - lineBreak: Normalize line breaks
 * - postprocessContent: User-defined post-DOM hook for final content postprocessing
 * @param context - Required context (content, inputPath, outputPath, outputDir, context, compile)
 * @param options - Optional options organized by transformation phase
 * @returns Transformed HTML content or ArrayBuffer
 */
export async function pageTransform(
	context: PageTransformContext,
	options?: PageTransformOptions,
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

	let content: string | ArrayBuffer = initialContent;

	// Phase 1: preprocessContent (DOM parsing前のコンテンツ前処理)
	for (const processor of [
		preprocessContent(
			{ transformContext, compile },
			{ preprocessContent: options?.preprocessContent, isServe },
		),
	]) {
		content = await processor(content);
	}

	// Phase 2: manipulateDOM (DOM操作)
	for (const processor of [
		manipulateDOM(
			{ outputDir, transformContext, compile },
			{
				imageSizes: options?.imageSizes,
				manipulateDOM: options?.manipulateDOM,
				url: options?.url,
				isServe,
			},
		),
	]) {
		content = await processor(content);
	}

	// Phase 3: postprocessContent (DOM serialization後のコンテンツ後処理)
	for (const processor of [
		characterEntities({ enabled: options?.characterEntities }),
		doctype(),
		prettier({ inputPath }, { prettier: options?.prettier }),
		minifier({ minifier: options?.minifier }),
		lineBreak({ lineBreak: options?.lineBreak }),
		postprocessContent(
			{ outputPath, outputDir },
			{ postprocessContent: options?.postprocessContent, isServe },
		),
	]) {
		content = await processor(content);
	}

	return content;
}
