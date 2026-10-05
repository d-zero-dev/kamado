/**
 * The v2 implementations the differential specs compare against, loaded from
 * the v2 package's source. A dynamic import with a computed URL keeps them out
 * of this package's `rootDir` / `composite` file list (a static import fails
 * type checking with TS6059/TS6307), so they are typed loosely here: pages are
 * v2-shaped (`metaData`), everything else is passed through.
 */

type V2Page = { url: string; filePathStem: string; metaData: Record<string, unknown> };

const base = new URL('../../../@kamado-io/page-compiler/src/features/', import.meta.url);

/**
 * Loads one v2 feature module.
 * @param name - File name without extension.
 * @returns The module namespace.
 */
async function load(
	name: string,
): Promise<Record<string, (...args: never[]) => unknown>> {
	return (await import(/* @vite-ignore */ new URL(`${name}.ts`, base).href)) as never;
}

const nav = await load('nav');
const breadcrumbs = await load('breadcrumbs');
const title = await load('title-list');

export const v2GetNavTree = nav.getNavTree as unknown as (
	context: { currentPage: { url: string }; pages: V2Page[] },
	options?: unknown,
) => unknown;
export const v2GetBreadcrumbs = breadcrumbs.getBreadcrumbs as unknown as (
	context: { page: V2Page; pageList: V2Page[] },
	options?: unknown,
) => unknown;
export const v2TitleList = title.titleList as unknown as (
	breadcrumbs: unknown[],
	options?: unknown,
) => string;
