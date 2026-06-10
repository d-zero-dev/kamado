import type { CreateBanner } from './banner.js';

import { createBanner } from './banner.js';

/**
 * Creates a banner resolver that caches the resolved banner per context.
 *
 * The banner is file-independent, so it is resolved once and reused across
 * all files of a build. Passing `cache = false` (serve mode) re-resolves on
 * every call so that date-based banners stay fresh per request.
 * @param banner - Banner configuration (a `CreateBanner` factory or a string)
 * @param transform - Optional post-processing applied to the resolved banner
 *   (e.g. normalizing it into a minifier-safe comment)
 * @returns Function that takes the compile `cache` flag and returns the banner
 */
export function createBannerResolver(
	banner: CreateBanner | string | undefined,
	transform?: (banner: string) => string,
): (cache?: boolean) => string {
	const resolve = () => {
		const raw = typeof banner === 'string' ? banner : createBanner(banner?.());
		return transform ? transform(raw) : raw;
	};
	let cached: string | undefined;
	return (cache) => (cache === false ? resolve() : (cached ??= resolve()));
}
