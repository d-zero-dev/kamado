import type { ImageSizesOptions } from '../image.js';
import type { Transform, TransformContext } from 'kamado/config';

import path from 'node:path';

import { JSDOM } from 'jsdom';

import { imageSizes } from '../image.js';

/**
 * Options for manipulateDOM
 */
export interface ManipulateDOMOptions {
	readonly hook?: (
		elements: readonly Element[],
		window: JSDOM['window'],
		context: TransformContext,
	) => Promise<void> | void;
	readonly host?: string;
	readonly imageSizes?: ImageSizesOptions | boolean;
}

/**
 * Creates a transform for DOM manipulation
 * @param options - DOM manipulation options
 * @returns Transform object
 */
export function manipulateDOM(options?: ManipulateDOMOptions): Transform {
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

			const isServe = ctx.isServe;
			const host =
				options?.host ??
				(isServe
					? `http://${ctx.context.devServer.host}:${ctx.context.devServer.port}`
					: (ctx.context.pkg.production?.baseURL ??
						(ctx.context.pkg.production?.host
							? `http://${ctx.context.pkg.production.host}`
							: undefined)));

			const dom = new JSDOM(content, { url: host });
			const { window } = dom;
			const elements = [...window.document.querySelectorAll('*')];

			// Apply custom hook if provided
			if (options?.hook) {
				await options.hook(elements, window, ctx);
			}

			// Apply imageSizes if enabled (default: false unless explicitly true)
			if (options?.imageSizes !== false) {
				const imgElements = [...window.document.querySelectorAll('img')];
				const rootDir = path.resolve(ctx.outputDir);
				await imageSizes(imgElements, {
					rootDir,
					...(typeof options?.imageSizes === 'object' ? options.imageSizes : {}),
				});
			}

			return dom.serialize();
		},
	};
}
