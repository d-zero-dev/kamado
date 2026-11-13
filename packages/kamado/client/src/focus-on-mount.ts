// The editors of the grid take the focus when they open, as `autoFocus` of React does: React
// calls `focus()` when the element is mounted. Written as a callback ref, the attribute
// `autofocus` is not in the markup, which markuplint reads as the one-per-document `autofocus`
// of HTML (the editors and the buttons of the dialog that are not on the screen together
// would all be reported as duplicates, and the editors as an `autofocus` outside a dialog).

/**
 * A callback `ref` that gives the focus to the element when it is mounted.
 * @param element - The element that React mounts, or `null` when it is unmounted
 * @example
 * ```tsx
 * <input ref={focusOnMount} />
 * ```
 */
export function focusOnMount(element: HTMLElement | null): void {
	element?.focus();
}

/**
 * A callback `ref` that gives the focus to the element when it is mounted as (or into) the first
 * item of a list. It is one function for every item, and it asks the document where the item is
 * when it is mounted: a ref that is given to the first item only would be called again when the
 * items are moved (the item that comes to the top takes the focus from the one that was moved).
 * @param element - The element that React mounts, or `null` when it is unmounted
 * @example
 * ```tsx
 * <ul>{items.map((item) => <li key={item.id}><input ref={focusOnMountIfFirst} /></li>)}</ul>
 * ```
 */
export function focusOnMountIfFirst(element: HTMLElement | null): void {
	if (element !== null && element.closest('li')?.previousElementSibling === null) {
		element.focus();
	}
}

/**
 * A callback `ref` that gives the focus to the box when it is mounted as (or into) the first
 * choice of a group of boxes, each in its own `label`. It is one function for every box, for the
 * reason that `focusOnMountIfFirst` is.
 * @param element - The element that React mounts, or `null` when it is unmounted
 * @example
 * ```tsx
 * <div>{choices.map((c) => <label key={c}><input type="checkbox" ref={focusOnMountIfFirstChoice} /></label>)}</div>
 * ```
 */
export function focusOnMountIfFirstChoice(element: HTMLElement | null): void {
	if (element !== null && element.closest('label')?.previousElementSibling === null) {
		element.focus();
	}
}
