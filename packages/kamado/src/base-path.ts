/**
 * The path part of the site's base URL, which is what the breadcrumbs cut
 * at: `https://example.com/sub/` is `/sub/`, a plain path stays as it is.
 * @param baseURL - `site.baseURL`
 * @example
 * ```ts
 * import { basePathOf } from 'kamado/jsx';
 *
 * basePathOf('https://example.com/sub/'); // '/sub/'
 * ```
 */
export function basePathOf(baseURL: string | null): string {
	if (!baseURL) {
		return '/';
	}
	if (baseURL.startsWith('/')) {
		return baseURL;
	}
	try {
		return new URL(baseURL).pathname;
	} catch {
		return '/';
	}
}
