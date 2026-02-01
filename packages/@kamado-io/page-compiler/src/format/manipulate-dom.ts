import type { PageCompilerOptions } from '../types.js';
import type { CompileFunction } from 'kamado/compiler';
import type { TransformContext } from 'kamado/config';

import path from 'node:path';

import { domSerialize as serializeDom } from 'kamado/utils/dom';

import { imageSizes } from '../image.js';

/**
 * Required context for DOM manipulation
 */
export interface ManipulateDOMContext {
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
 * Options for DOM manipulation
 */
export interface ManipulateDOMOptions {
	/**
	 * Configuration for automatically adding width/height attributes to images
	 * Set to false to disable image size injection
	 * @default true
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
	/**
	 * Whether running on development server
	 * @default false
	 */
	readonly isServe?: boolean;
}

/**
 * Applies DOM manipulation with image size injection and manipulateDOM hook.
 *
 * Only performs DOM operations if imageSizes or manipulateDOM is enabled.
 * This is the most complex processing step, involving:
 * - Parsing HTML into a DOM
 * - Injecting width/height attributes to images (if enabled)
 * - Executing the manipulateDOM hook (if provided)
 * - Serializing the DOM back to HTML
 * @param context - Required context (outputDir, transformContext, compile)
 * @param options - Configuration options
 * @returns A function that takes content and returns a Promise of processed content
 * @internal
 */
export function manipulateDOM(
	context: ManipulateDOMContext,
	options?: ManipulateDOMOptions,
): (content: string | ArrayBuffer) => Promise<string | ArrayBuffer> {
	return async (content: string | ArrayBuffer): Promise<string | ArrayBuffer> => {
		if (typeof content !== 'string') {
			return content;
		}

		const { outputDir, transformContext, compile } = context;
		const {
			imageSizes: imageSizesOption,
			manipulateDOM,
			url,
			isServe = false,
		} = options ?? {};

		const imageSizesValue = imageSizesOption ?? true;

		// Skip DOM operations if both imageSizes and manipulateDOM are disabled
		if (!imageSizesValue && !manipulateDOM) {
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

				// manipulateDOM hook
				await manipulateDOM?.(elements, window, isServe, transformContext, compile);
			},
			url,
		});
	};
}
