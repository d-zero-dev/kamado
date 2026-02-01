import type { PageCompilerOptions } from '../types.js';
import type { CompileFunction } from 'kamado/compiler';
import type { TransformContext } from 'kamado/config';

import path from 'node:path';

import { domSerialize as serializeDom } from 'kamado/utils/dom';

import { imageSizes } from '../image.js';

/**
 * Required context for DOM serialization
 */
export interface DomSerializeContext {
	/**
	 * Output directory path (used for image size calculation)
	 */
	readonly outputDir: string;
	/**
	 * Transform context to pass to hooks
	 */
	readonly transformContext: TransformContext;
	/**
	 * Compile function to pass to hooks
	 */
	readonly compile: CompileFunction;
}

/**
 * Options for DOM serialization
 */
export interface DomSerializeOptions {
	/**
	 * Configuration for automatically adding width/height attributes to images
	 * Set to false to disable image size injection
	 * @default true
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
	/**
	 * Whether running on development server
	 * @default false
	 */
	readonly isServe?: boolean;
}

/**
 * Applies DOM serialization with image size injection and afterSerialize hook.
 *
 * Only performs DOM serialization if imageSizes or afterSerialize is enabled.
 * This is the most complex processing step, involving:
 * - Parsing HTML into a DOM
 * - Injecting width/height attributes to images (if enabled)
 * - Executing the afterSerialize hook (if provided)
 * - Serializing the DOM back to HTML
 * @param context - Required context (outputDir, transformContext, compile)
 * @param options - Configuration options
 * @returns A function that takes content and returns a Promise of processed content
 * @internal
 */
export function domSerialize(
	context: DomSerializeContext,
	options?: DomSerializeOptions,
): (content: string | ArrayBuffer) => Promise<string | ArrayBuffer> {
	return async (content: string | ArrayBuffer): Promise<string | ArrayBuffer> => {
		if (typeof content !== 'string') {
			return content;
		}

		const { outputDir, transformContext, compile } = context;
		const {
			imageSizes: imageSizesOption,
			afterSerialize,
			url,
			isServe = false,
		} = options ?? {};

		const imageSizesValue = imageSizesOption ?? true;

		// Skip DOM serialization if both imageSizes and afterSerialize are disabled
		if (!imageSizesValue && !afterSerialize) {
			return content;
		}

		return await serializeDom(content, {
			hook: async (elements, window) => {
				// Image size injection
				if (imageSizesValue) {
					const imageSizeOpts =
						typeof imageSizesValue === 'object' ? imageSizesValue : {};
					const rootDir = path.resolve(outputDir);
					await imageSizes(elements, {
						rootDir,
						...imageSizeOpts,
					});
				}

				// afterSerialize hook
				await afterSerialize?.(elements, window, isServe, transformContext, compile);
			},
			url,
		});
	};
}
