import { JSDOM } from 'jsdom';

/**
 * Options for DOM serialization
 */
export interface DomSerializeOptions {
	/**
	 * Hook function to manipulate DOM elements before serialization
	 */
	readonly hook: (elements: Element[], window: Window) => Promise<void> | void;
	/**
	 * URL for JSDOM (optional)
	 */
	readonly url?: string;
}

/**
 * Serializes HTML with DOM manipulation hook
 * @param html - HTML content to serialize
 * @param options - Serialization options (hook, url)
 * @returns Serialized HTML string
 * @example
 * ```typescript
 * const result = await domSerialize(html, {
 *   hook: async (elements, window) => {
 *     // Manipulate DOM elements
 *   },
 *   url: 'https://example.com',
 * });
 * ```
 */
export async function domSerialize(html: string, options: DomSerializeOptions) {
	const { hook, url } = options;
	const dom = getDOM(html, url);
	await hook(dom.elements, dom.window);
	const serialized = dom.elements.map((node) => node.outerHTML).join('');
	return serialized;
}

/**
 *
 * @param html
 * @param url
 */
function getDOM(
	html: string,
	url?: string,
): {
	elements: Element[];
	document: Document;
	window: Window;
	isFragment: boolean;
} {
	const isFragment = !/^<html(?:\s|>)|^<!doctype\s/i.test(html.trim());

	if (isFragment) {
		const window = new JSDOM('', url ? { url } : {}).window;
		const document = window.document;
		const tmpContainer = document.createElement('div');
		tmpContainer.insertAdjacentHTML('beforeend', html);

		return {
			elements: [...tmpContainer.children],
			document,
			window: window as unknown as Window,
			isFragment: true,
		};
	}

	const dom = new JSDOM(html, url ? { url } : {});

	return {
		elements: [dom.window.document.documentElement],
		document: dom.window.document,
		window: dom.window as unknown as Window,
		isFragment: false,
	};
}
