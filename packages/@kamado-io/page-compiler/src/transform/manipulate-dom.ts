import type { ImageSizesOptions } from '../image.js';
import type { Transform, TransformContext } from 'kamado/config';
import type { MetaData } from 'kamado/files';
import type { DomElement, DomWindow } from 'kamado/utils/dom';

import path from 'node:path';

import { domSerialize, resolveHref } from 'kamado/utils/dom';

import { imageSizes } from '../image.js';

/**
 * Hook context for manipulateDOM. Extends the standard TransformContext with
 * URL helpers that compensate for linkedom not populating `window.location` /
 * `Document.baseURI`.
 * @template M - Metadata (frontmatter) type for pages handled by this transform
 */
export interface ManipulateDOMHookContext<
	M extends MetaData,
> extends TransformContext<M> {
	/**
	 * Resolved base URL for the current mode:
	 *   serve → `http://${ctx.context.devServer.host}:${ctx.context.devServer.port}`
	 *   build → `ctx.context.pkg.production?.baseURL`, or `http://${ctx.context.pkg.production.host}` as a fallback.
	 * `undefined` when neither is configured (a relative `href` then resolves to `null`).
	 */
	readonly baseURL: string | undefined;
	/**
	 * Resolves the element's `href` attribute against {@link baseURL}.
	 * Returns `null` when the attribute is missing/empty or unparsable, or
	 * when the value is relative and `baseURL` is `undefined`.
	 *
	 * Intended for elements that carry an `href` attribute
	 * (`<a>` / `<link>` / `<area>` / `<base>`). For other URL-bearing
	 * attributes (`<img src>` etc.) read the attribute directly and call
	 * `new URL(raw, ctx.baseURL)` in user code.
	 */
	readonly getHref: (el: DomElement) => string | null;
}

/**
 * Options for manipulateDOM
 * @template M - Metadata (frontmatter) type passed through to the hook callback
 */
export interface ManipulateDOMOptions<M extends MetaData> {
	readonly hook?: (
		elements: readonly DomElement[],
		window: DomWindow,
		context: ManipulateDOMHookContext<M>,
	) => Promise<void> | void;
	readonly imageSizes?: ImageSizesOptions | boolean;
}

/**
 * Resolves the base URL the hook will see, mirroring the jsdom-era behavior
 * of the removed `url`/`host` options: serve mode uses the dev server's
 * URL, build mode uses `pkg.production.baseURL` (falling back to `host`).
 * @param ctx - the transform context for the current compilation
 */
function resolveBaseURL<M extends MetaData>(
	ctx: TransformContext<M>,
): string | undefined {
	if (ctx.isServe) {
		return `http://${ctx.context.devServer.host}:${ctx.context.devServer.port}`;
	}
	const { baseURL, host } = ctx.context.pkg.production ?? {};
	if (baseURL) {
		return baseURL;
	}
	if (host) {
		return `http://${host}`;
	}
	return undefined;
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

			const baseURL = resolveBaseURL(ctx);
			const hookCtx: ManipulateDOMHookContext<M> = {
				...ctx,
				baseURL,
				getHref: (el) => resolveHref(el, baseURL),
			};

			return await domSerialize(content, {
				hook: async (elements, window) => {
					// Apply custom hook if provided
					if (options?.hook) {
						await options.hook(elements, window, hookCtx);
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
