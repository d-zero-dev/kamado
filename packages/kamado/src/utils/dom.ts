import { parseHTML } from 'linkedom';

/**
 * `Window`-like object returned by linkedom's `parseHTML`. Re-exported so
 * downstream packages can type their DOM-manipulation hooks without
 * importing linkedom directly. Does **not** implement layout APIs
 * (`getBoundingClientRect`, `getComputedStyle`) — see ARCHITECTURE.md for
 * the linkedom-vs-jsdom compatibility table.
 */
export type DomWindow = ReturnType<typeof parseHTML>;

/**
 * `Document` held by a {@link DomWindow}.
 */
export type DomDocument = DomWindow['document'];

/**
 * `Element` type as returned by linkedom's `document.querySelector`. Used by
 * {@link domSerialize}'s hook contract and re-exported so downstream packages
 * can type their hook implementations without importing linkedom directly.
 */
export type DomElement = NonNullable<ReturnType<DomDocument['querySelector']>>;

/**
 * Options for {@link domSerialize}.
 */
export interface DomSerializeOptions {
	/**
	 * Hook invoked after parsing but before serialization. Receives the
	 * top-level elements of the parsed input and the owning window so the
	 * caller can mutate the DOM in place; mutations are reflected in the
	 * returned string. May be async.
	 */
	readonly hook: (elements: DomElement[], window: DomWindow) => Promise<void> | void;
}

/**
 * Parses an HTML string, invokes the provided hook against the resulting DOM,
 * and returns the serialized result.
 *
 * Recognizes both fragment and full-document inputs and re-serializes them in
 * the same shape (fragment in → fragment out). A bare `<!doctype html>` with
 * no `<html>` body returns an empty string instead of throwing.
 * @param html - HTML content to serialize (fragment or full document).
 * @param options - Serialization options (currently just the hook).
 * @returns The serialized HTML string.
 * @example
 * const result = await domSerialize(html, {
 *   hook: async (elements, window) => {
 *     for (const a of window.document.querySelectorAll('a')) {
 *       a.setAttribute('rel', 'noopener');
 *     }
 *   },
 * });
 */
export async function domSerialize(html: string, options: DomSerializeOptions) {
	const { hook } = options;
	const dom = getDOM(html);
	await hook(dom.elements, dom.window);
	return dom.serialize();
}

/**
 * Schemes resolveHref refuses to emit so the helper is safe-by-default for
 * HTML output. Hook authors that genuinely want to handle them can read the
 * attribute directly and call `new URL(...)` themselves.
 */
const REJECTED_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:']);

/**
 * Resolves an element's `href` attribute against a base URL, returning an
 * absolute URL safe to interpolate into rendered HTML.
 *
 * linkedom does not populate `window.location` or `Document.baseURI`, so
 * reading `<a>.href` directly returns the raw attribute instead of an
 * absolute URL — this helper plugs that gap for DOM-manipulation hooks.
 * Dangerous schemes (`javascript:` / `data:` / `vbscript:` / `file:`) are
 * rejected and basic-auth credentials in `base` are scrubbed so the
 * resolved value cannot leak passwords into HTML, sitemaps, or caches.
 * @param el - DOM element holding the `href` attribute (typically `<a>` /
 *   `<link>` / `<area>` / `<base>`).
 * @param base - Base URL used to absolutize relative `href` values. Accepts a
 *   string or a `URL` instance; if omitted, only already-absolute `href`
 *   attributes resolve and relative ones return `null`.
 * @returns The absolute URL string, or `null` when the attribute is
 *   missing/empty, the value cannot be parsed, the value is relative and
 *   `base` is missing, or the scheme is in the rejected list.
 */
export function resolveHref(el: DomElement, base?: string | URL): string | null {
	const raw = el.getAttribute('href');
	if (!raw) {
		return null;
	}
	let url: URL;
	try {
		url = new URL(raw, base);
	} catch {
		return null;
	}
	if (REJECTED_SCHEMES.has(url.protocol)) {
		return null;
	}
	// Strip basic-auth credentials so a misconfigured base URL with userinfo
	// (e.g. 'https://user:pass@staging.example.com') can't leak the password
	// into rendered HTML, sitemaps, or build-cache artifacts.
	url.username = '';
	url.password = '';
	return url.href;
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
	// linkedom recognizes only `-->` as a comment terminator, but HTML5 also
	// tolerates `--!>`. Normalize the alternate form up-front so both fragment
	// detection AND the downstream parser see a closed comment instead of an
	// unclosed one that would swallow the rest of the document.
	const normalized = html.replaceAll(/<!--([\s\S]*?)--!>/g, '<!--$1-->');
	// Strip leading HTML comments and whitespace before fragment detection so
	// a `<!-- license -->` banner doesn't misclassify a full document as a
	// fragment.
	const stripped = normalized.trim().replace(/^(?:<!--[\s\S]*?-->\s*)*/, '');
	const isFragment = !/^<html(?:\s|>)|^<!doctype\s/i.test(stripped);

	if (isFragment) {
		const window = parseHTML('<html></html>');
		const { document } = window;
		const tmpContainer = document.createElement('div');
		tmpContainer.insertAdjacentHTML('beforeend', normalized);

		return {
			elements: [...tmpContainer.children] as DomElement[],
			document,
			window,
			isFragment: true,
			// innerHTML preserves text and comment nodes that .children would drop
			serialize: () => tmpContainer.innerHTML,
		};
	}

	const window = parseHTML(normalized);
	const { document } = window;
	const root = document.documentElement as DomElement | null;

	// linkedom does not auto-create <head> for head-less pages; downstream
	// regex-based transforms (e.g. inject-to-head) need </head> to anchor on.
	// Walk the children explicitly instead of reading `document.head` — that
	// getter has been observed to materialize a <head> as a side effect on
	// first access in some linkedom versions, which would make the explicit
	// insertion dead code that silently breaks if the getter ever stops doing
	// that.
	if (root) {
		const hasHead = [...root.children].some(
			(child) => (child.tagName ?? '').toLowerCase() === 'head',
		);
		if (!hasHead) {
			const head = document.createElement('head');
			root.insertBefore(head, root.firstChild);
		}
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
