import type { ImageSizesOptions } from '../image.js';
import type { Transform, TransformContext } from 'kamado/config';
import type { MetaData } from 'kamado/files';
import type { DomElement, DomWindow } from 'kamado/utils/dom';

import path from 'node:path';

import { domSerialize } from 'kamado/utils/dom';

import { imageSizes } from '../image.js';

/**
 * Options for manipulateDOM
 * @template M - Metadata (frontmatter) type passed through to the hook callback
 */
export interface ManipulateDOMOptions<M extends MetaData> {
	readonly hook?: (
		elements: readonly DomElement[],
		window: DomWindow,
		context: TransformContext<M>,
	) => Promise<void> | void;
	readonly imageSizes?: ImageSizesOptions | boolean;
}

/**
 * Creates a transform for DOM manipulation
 * @template M - Metadata (frontmatter) type for pages handled by this transform
 * @param options - DOM manipulation options
 * @returns Transform object
 */
export function manipulateDOM<M extends MetaData>(
	options?: ManipulateDOMOptions<M>,
): Transform<M> {
	return {
		name: 'manipulateDOM',
		transform: async (content, ctx) => {
			// Skip if no hook and imageSizes is disabled
			if (!options?.hook && options?.imageSizes === false) {
				return content;
			}

			if (typeof content !== 'string') {
				const decoder = new TextDecoder('utf-8');
				content = decoder.decode(content);
			}

			return await domSerialize(content, {
				hook: async (elements, window) => {
					// Apply custom hook if provided
					if (options?.hook) {
						await options.hook(elements, window, ctx);
					}

					// Apply imageSizes if enabled (default: true)
					if (options?.imageSizes !== false) {
						const rootDir = path.resolve(ctx.outputDir);
						await imageSizes(elements, {
							rootDir,
							...(typeof options?.imageSizes === 'object' ? options.imageSizes : {}),
						});
					}
				},
			});
		},
	};
}
