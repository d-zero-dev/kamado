import type { ResponseTransform, TransformContext } from 'kamado/config';

/**
 * Position where content should be injected in the head element
 */
export type InjectPosition = 'head-start' | 'head-end';

/**
 * Options for injectToHead transform function
 */
export interface InjectToHeadTransformOptions {
	/**
	 * HTML content to inject into the head element
	 * Can be a string or a function that returns a string (sync or async)
	 * @example '<script src="/__dev-tools.js"></script>'
	 * @example '<meta name="viewport" content="width=device-width, initial-scale=1">'
	 */
	readonly content: string | (() => string | Promise<string>);
	/**
	 * Position where the content should be injected
	 * - 'head-start': Inject right after the opening <head> tag
	 * - 'head-end': Inject right before the closing </head> tag (default)
	 * @default 'head-end'
	 */
	readonly position?: InjectPosition;
}

/**
 * Options for injectToHead utility (includes filter options)
 */
export interface InjectToHeadOptions extends InjectToHeadTransformOptions {
	/**
	 * Optional name for debugging
	 * @default 'inject-to-head'
	 */
	readonly name?: string;
	/**
	 * Filter options to limit which files this transform applies to
	 */
	readonly filter?: {
		/**
		 * Glob pattern(s) to include
		 * @default '**\/*.html'
		 */
		readonly include?: string | readonly string[];
		/**
		 * Glob pattern(s) to exclude
		 */
		readonly exclude?: string | readonly string[];
	};
}

/**
 * Create a transform function that injects content into the HTML head element
 * This is the core transform function without filter configuration.
 * Use this when you want to create custom ResponseTransform objects.
 * @param options - Transform options
 * @returns Transform function (content, context) => Promise<string | ArrayBuffer>
 * @example Creating a custom ResponseTransform
 * ```typescript
 * import { createInjectToHeadTransform } from '@kamado-io/page-compiler/dev-transform/inject-to-head';
 *
 * export const config: UserConfig = {
 *   devServer: {
 *     transforms: [
 *       {
 *         name: 'my-custom-inject',
 *         filter: { include: '**\/*.html' },
 *         transform: createInjectToHeadTransform({
 *           content: '<script src="/__dev.js"></script>',
 *           position: 'head-end',
 *         }),
 *       },
 *     ],
 *   },
 * };
 * ```
 */
export function createInjectToHeadTransform(options: InjectToHeadTransformOptions) {
	const position = options.position ?? 'head-end';

	return async (
		content: string | ArrayBuffer,
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		_context: TransformContext,
	): Promise<string | ArrayBuffer> => {
		// Decode ArrayBuffer to string if needed
		let htmlContent: string;
		if (typeof content === 'string') {
			htmlContent = content;
		} else {
			const decoder = new TextDecoder('utf-8');
			htmlContent = decoder.decode(content);
		}

		// Get content to inject (support function)
		const injectContent =
			typeof options.content === 'function'
				? await Promise.resolve(options.content())
				: options.content;

		// Inject based on position
		if (position === 'head-start') {
			// Inject right after <head>
			return htmlContent.replace(/(<head[^>]*>)/i, `$1\n${injectContent}`);
		} else {
			// Inject right before </head>
			return htmlContent.replace(/(<\/head>)/i, `${injectContent}\n$1`);
		}
	};
}

/**
 * Create a complete ResponseTransform that injects content into the HTML head element
 * This is a convenience wrapper around createInjectToHeadTransform with filter configuration.
 * Returns a ResponseTransform object with name and filter included, which can be used directly
 * or customized via spread syntax.
 * @param options - Configuration options including filters
 * @returns ResponseTransform object for use in devServer.transforms
 * @example Basic usage
 * ```typescript
 * import { injectToHead } from '@kamado-io/page-compiler/dev-transform/inject-to-head';
 *
 * export const config: UserConfig = {
 *   devServer: {
 *     transforms: [
 *       injectToHead({
 *         content: '<script src="/__dev-tools.js"></script>',
 *         position: 'head-end',
 *       }),
 *     ],
 *   },
 * };
 * ```
 * @example Customizing with spread syntax
 * ```typescript
 * transforms: [
 *   {
 *     ...injectToHead({ content: '<script src="/dev.js"></script>' }),
 *     name: 'my-custom-inject',
 *   },
 * ]
 * ```
 * @example Using a function for dynamic content
 * ```typescript
 * injectToHead({
 *   content: () => `<meta name="build-time" content="${Date.now()}">`,
 *   position: 'head-start',
 * })
 * ```
 */
export function injectToHead(options: InjectToHeadOptions): ResponseTransform {
	const name = options.name ?? 'inject-to-head';

	return {
		name,
		filter: {
			include: options.filter?.include ?? '**/*.html',
			exclude: options.filter?.exclude,
		},
		transform: createInjectToHeadTransform(options),
	};
}
