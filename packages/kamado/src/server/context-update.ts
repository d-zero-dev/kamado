import type { PageEntry, RenderContext } from '../props.js';

/** What changed in the context since the renderer last saw it. */
export interface ContextUpdate {
	/** Pages whose metadata changed: `[index, page]`. */
	readonly pages: readonly (readonly [number, PageEntry])[];
	/** The new data, or `null` when it did not change. */
	readonly data: Record<string, unknown> | null;
}

/**
 * Applies an update. The result is a new object, so that what the props
 * helpers cached for the old context (the page list, breadcrumbs) is not
 * used for the new one.
 * @param context - The context the renderer has
 * @param update - What the core reports as changed
 * @returns The new context
 * @example
 * ```ts
 * const next = applyUpdate(context, { pages: [[3, page]], data: null });
 * ```
 */
export function applyUpdate(
	context: RenderContext,
	update: ContextUpdate,
): RenderContext {
	const pages = [...context.pages];
	for (const [index, page] of update.pages) {
		pages[index] = page;
	}
	return { site: context.site, data: update.data ?? context.data, pages };
}
