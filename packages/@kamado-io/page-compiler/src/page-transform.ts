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
	// Phase 1: beforeFormat (DOM操作前)
	/**
	 * Hook function called before DOM serialization
	 */
	readonly beforeSerialize?: PageCompilerOptions['beforeSerialize'];

	// Phase 2: domManipulation (DOM操作)
	/**
	 * Configuration for automatically adding width/height attributes to images
	 */
	readonly imageSizes?: PageCompilerOptions['imageSizes'];
	/**
	 * Hook function called after DOM serialization
	 */
	readonly afterSerialize?: PageCompilerOptions['afterSerialize'];
	/**
	 * JSDOM URL configuration (optional)
	 */
	readonly url?: string;

	// Phase 3: afterFormat (DOM操作後)
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
 * Phase 1 (beforeFormat): String transformations before DOM parsing
 * - beforeSerialize: User-defined pre-DOM hook
 *
 * Phase 2 (domManipulation): DOM-based transformations
 * - domSerialize: DOM parsing, image size injection, afterSerialize hook
 *
 * Phase 3 (afterFormat): String transformations after DOM serialization
 * - characterEntities: Convert characters to HTML entities
 * - doctype: Insert DOCTYPE declaration
 * - prettier: Format with Prettier
 * - minifier: Minify HTML
 * - lineBreak: Normalize line breaks
 * - replace: Final content replacement
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

	// Phase 1: beforeFormat (DOM操作前)
	for (const processor of [
		beforeSerialize(
			{ transformContext, compile },
			{ beforeSerialize: options?.beforeSerialize, isServe },
		),
	]) {
		content = await processor(content);
	}

	// Phase 2: domManipulation (DOM操作)
	for (const processor of [
		domSerialize(
			{ outputDir, transformContext, compile },
			{
				imageSizes: options?.imageSizes,
				afterSerialize: options?.afterSerialize,
				url: options?.url,
				isServe,
			},
		),
	]) {
		content = await processor(content);
	}

	// Phase 3: afterFormat (DOM操作後)
	for (const processor of [
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
