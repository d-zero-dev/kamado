import type { ImageSizesOptions } from '../image.js';
import type { Transform, TransformContext } from 'kamado/config';
import type { MetaData } from 'kamado/files';
import type { DomElement, DomWindow } from 'kamado/utils/dom';

import path from 'node:path';

import { domSerialize, resolveHref } from 'kamado/utils/dom';

import { imageSizes } from '../image.js';

/**
 * Hook context for {@link manipulateDOM}. Extends the standard
 * `TransformContext` with URL helpers that compensate for linkedom not
 * populating `window.location` / `Document.baseURI`.
 * @template M - Metadata (frontmatter) type for pages handled by this transform.
 */
export interface ManipulateDOMHookContext<
	M extends MetaData,
> extends TransformContext<M> {
	/**
	 * Resolved base URL for the current mode:
	 *   - serve → `http://${ctx.context.devServer.host}:${ctx.context.devServer.port}`
	 *   - build → `ctx.context.pkg.production?.baseURL`, falling back to
	 *     `https://${ctx.context.pkg.production.host}` (HTTPS-by-default so
	 *     canonical links don't trigger mixed-content / SEO regressions).
	 *
	 * `undefined` when neither is configured (and a relative `href` then
	 * resolves to `null` via {@link getHref}). Empty / whitespace-only
	 * values are treated as missing; a non-parseable value (e.g. `'example.com'`
	 * without a scheme) also returns `undefined`.
	 */
	readonly baseURL: string | undefined;
	/**
	 * Resolves the element's `href` attribute against {@link baseURL} and
	 * returns an absolute URL safe to interpolate into rendered HTML.
	 * Dangerous schemes (`javascript:` / `data:` / `vbscript:` / `file:`) and
	 * basic-auth credentials in `baseURL` are stripped from the result.
	 *
	 * Returns `null` when the attribute is missing/empty, the value cannot be
	 * parsed, the value is relative and `baseURL` is `undefined`, or the
	 * scheme is rejected.
	 *
	 * Intended for elements that carry an `href` attribute
	 * (`<a>` / `<link>` / `<area>` / `<base>`). For other URL-bearing
	 * attributes (e.g. `<img src>`) read the attribute directly and call
	 * `new URL(raw, ctx.baseURL)` in user code.
	 * @param el - DOM element to read the `href` attribute from.
	 * @returns Absolute URL string, or `null` (see above).
	 */
	readonly getHref: (el: DomElement) => string | null;
}

/**
 * Options for {@link manipulateDOM}.
 * @template M - Metadata (frontmatter) type passed through to the hook callback.
 */
export interface ManipulateDOMOptions<M extends MetaData> {
	/**
	 * Custom hook invoked after parsing but before serialization. Receives
	 * the top-level elements, the linkedom `Window`, and a
	 * {@link ManipulateDOMHookContext} that adds `baseURL` and `getHref` to
	 * the standard `TransformContext`. May be async.
	 */
	readonly hook?: (
		elements: readonly DomElement[],
		window: DomWindow,
		context: ManipulateDOMHookContext<M>,
	) => Promise<void> | void;
	/**
	 * Configure automatic `width`/`height` attribute injection on `<img>` and
	 * `<picture> > <source>`. `true` enables the defaults, `false` disables
	 * the feature entirely. Pass an object for fine-grained options
	 * (`rootDir`, `selector`, `ext`) — see {@link ImageSizesOptions}.
	 */
	readonly imageSizes?: ImageSizesOptions | boolean;
}

/**
 * Resolves the base URL the hook will see. Returns `undefined` instead of a
 * malformed URL so {@link resolveHref}'s null-fallback path is the only
 * failure mode hook authors have to handle.
 *
 * - Serve mode → `http://<devServer.host>:<devServer.port>` when both are present.
 * - Build mode → `pkg.production.baseURL` if it parses, else
 *   `https://<pkg.production.host>` (HTTPS-by-default), else `undefined`.
 *
 * Whitespace is trimmed; empty strings are treated as missing.
 * @template M - Metadata (frontmatter) type for the transform's pages.
 * @param ctx - The transform context for the current compilation.
 * @returns The resolved base URL, or `undefined` when no usable value is
 *   configured.
 */
function resolveBaseURL<M extends MetaData>(
	ctx: TransformContext<M>,
): string | undefined {
	let candidate: string | undefined;
	if (ctx.isServe) {
		const dev = ctx.context.devServer;
		if (dev?.host && dev.port != null) {
			candidate = `http://${dev.host}:${dev.port}`;
		}
	} else {
		const production = ctx.context.pkg.production;
		const baseURL = production?.baseURL?.trim();
		const host = production?.host?.trim();
		candidate = baseURL || (host ? `https://${host}` : undefined);
	}
	if (!candidate) {
		return undefined;
	}
	try {
		const url = new URL(candidate);
		// new URL('https://example.com').href is 'https://example.com/' — drop
		// that synthetic trailing slash when the user gave a bare origin so
		// the returned baseURL keeps the user-supplied shape. URL resolution
		// (`new URL('/foo', baseURL)`) works the same with or without it.
		if (url.pathname === '/' && !url.search && !url.hash) {
			return url.origin;
		}
		return url.href;
	} catch {
		return undefined;
	}
}

/**
 * Creates a page transform that parses HTML through linkedom, runs the
 * optional `hook` against the resulting DOM (with {@link ManipulateDOMHookContext}
 * providing `baseURL` / `getHref`), and applies the imageSizes pass for
 * automatic `width`/`height` injection.
 * @template M - Metadata (frontmatter) type for pages handled by this transform.
 * @param options - Hook and imageSizes configuration. Omitting both `hook`
 *   and setting `imageSizes: false` makes the transform a no-op.
 * @returns A `Transform` ready to be added to a page-compiler pipeline.
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
