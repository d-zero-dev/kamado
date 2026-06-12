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
	return dom.serialize();
}

/**
 * Resolves an element's `href` attribute against a base URL.
 *
 * linkedom does not populate `window.location` or `Document.baseURI`, so
 * reading `<a>.href` directly returns the raw attribute value instead of an
 * absolute URL. This helper plugs that gap for DOM-manipulation hooks: pass
 * the element and the base URL the consumer wants relative paths resolved
 * against, and get back an absolute URL string or null.
 * @param el   - DOM element (typically `<a>` / `<link>` / `<area>` / `<base>`)
 * @param base - base URL used to absolutize relative href values
 * @returns absolute URL string, or null when the attribute is missing/empty,
 *          the value cannot be parsed, or the value is relative AND base is
 *          missing.
 */
export function resolveHref(el: DomElement, base?: string | URL): string | null {
	const raw = el.getAttribute('href');
	if (!raw) {
		return null;
	}
	try {
		return new URL(raw, base).href;
	} catch {
		return null;
	}
}

/**
 * Parses HTML string with linkedom and returns DOM elements
 * @param html - HTML content to parse
 * @returns Object containing parsed elements, document, window, fragment flag, and a serializer
 */
function getDOM(html: string): {
	elements: DomElement[];
	document: DomDocument;
	window: DomWindow;
	isFragment: boolean;
	serialize: () => string;
} {
	// Strip leading HTML comments and whitespace before fragment detection,
	// so a `<!-- license -->` banner doesn't misclassify a full document as a fragment.
	const stripped = html.trim().replace(/^(?:<!--[\s\S]*?-->\s*)*/, '');
	const isFragment = !/^<html(?:\s|>)|^<!doctype\s/i.test(stripped);

	if (isFragment) {
		const window = parseHTML('<html></html>');
		const { document } = window;
		const tmpContainer = document.createElement('div');
		tmpContainer.insertAdjacentHTML('beforeend', html);

		return {
			elements: [...tmpContainer.children] as DomElement[],
			document,
			window,
			isFragment: true,
			// innerHTML preserves text and comment nodes that .children would drop
			serialize: () => tmpContainer.innerHTML,
		};
	}

	const window = parseHTML(html);
	const { document } = window;
	const root = document.documentElement as DomElement | null;

	// linkedom does not auto-create <head> for head-less pages; downstream
	// regex-based transforms (e.g. inject-to-head) need </head> to anchor on.
	if (root && !document.head) {
		const head = document.createElement('head');
		root.insertBefore(head, root.firstChild);
	}

	return {
		elements: root ? [root] : [],
		document,
		window,
		isFragment: false,
		// linkedom returns null documentElement for inputs lacking <html>
		// (e.g. a bare "<!doctype html>"); fall back to an empty string
		// instead of crashing on `.outerHTML`.
		serialize: () => root?.outerHTML ?? '',
	};
}
