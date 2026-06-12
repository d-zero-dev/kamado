import { parseHTML } from 'linkedom';

/**
 * Window-like object returned by linkedom's parseHTML
 */
export type DomWindow = ReturnType<typeof parseHTML>;

/**
 * Document held by a DomWindow
 */
export type DomDocument = DomWindow['document'];

/**
 * Element type used across the DOM serializer (derived from linkedom's API)
 */
export type DomElement = NonNullable<ReturnType<DomDocument['querySelector']>>;

/**
 * Options for DOM serialization
 */
export interface DomSerializeOptions {
	/**
	 * Hook function to manipulate DOM elements before serialization
	 */
	readonly hook: (elements: DomElement[], window: DomWindow) => Promise<void> | void;
}

/**
 * Serializes HTML with DOM manipulation hook
 * @param html - HTML content to serialize
 * @param options - Serialization options (hook)
 * @returns Serialized HTML string
 * @example
 * ```typescript
 * const result = await domSerialize(html, {
 *   hook: async (elements, window) => {
 *     // Manipulate DOM elements
 *   },
 * });
 * ```
 */
export async function domSerialize(html: string, options: DomSerializeOptions) {
	const { hook } = options;
	const dom = getDOM(html);
	await hook(dom.elements, dom.window);
	const serialized = dom.elements.map((node) => node.outerHTML).join('');
	return serialized;
}

/**
 * Parses HTML string with linkedom and returns DOM elements
 * @param html - HTML content to parse
 * @returns Object containing parsed elements, document, window, and whether the input is a fragment
 */
function getDOM(html: string): {
	elements: DomElement[];
	document: DomDocument;
	window: DomWindow;
	isFragment: boolean;
} {
	const isFragment = !/^<html(?:\s|>)|^<!doctype\s/i.test(html.trim());

	if (isFragment) {
		const window = parseHTML('<!doctype html><html><head></head><body></body></html>');
		const { document } = window;
		const tmpContainer = document.createElement('div');
		tmpContainer.insertAdjacentHTML('beforeend', html);

		return {
			elements: [...tmpContainer.children] as DomElement[],
			document,
			window,
			isFragment: true,
		};
	}

	const window = parseHTML(html);

	return {
		elements: [window.document.documentElement],
		document: window.document,
		window,
		isFragment: false,
	};
}
