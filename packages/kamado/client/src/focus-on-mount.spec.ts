import { describe, expect, test } from 'vitest';

import {
	focusOnMount,
	focusOnMountIfFirst,
	focusOnMountIfFirstChoice,
} from './focus-on-mount.js';

/**
 * An element with what the two functions ask of it, and a record of the focus it was given.
 * @param previous - What `previousElementSibling` of its item is, or `'none'` when it is in no item
 * @example
 * ```ts
 * fake(null).focused; // 0
 * ```
 */
function fake(previous: object | null | 'none') {
	const element = {
		focused: 0,
		focus() {
			element.focused += 1;
		},
		closest: (selector: string) =>
			selector === 'li' && previous !== 'none'
				? { previousElementSibling: previous }
				: null,
	};
	return element;
}

describe('focusOnMount', () => {
	test('gives the focus to the element that is mounted', () => {
		const element = fake(null);
		focusOnMount(element as unknown as HTMLElement);
		expect(element.focused).toBe(1);
	});

	test('does nothing when the element is unmounted', () => {
		expect(() => focusOnMount(null)).not.toThrow();
	});
});

describe('focusOnMountIfFirst', () => {
	test('gives the focus to an element of the first item', () => {
		const element = fake(null);
		focusOnMountIfFirst(element as unknown as HTMLElement);
		expect(element.focused).toBe(1);
	});

	test('leaves the focus when the item has one before it', () => {
		const element = fake({});
		focusOnMountIfFirst(element as unknown as HTMLElement);
		expect(element.focused).toBe(0);
	});

	test('leaves the focus when the element is in no item', () => {
		const element = fake('none');
		focusOnMountIfFirst(element as unknown as HTMLElement);
		expect(element.focused).toBe(0);
	});

	test('does nothing when the element is unmounted', () => {
		expect(() => focusOnMountIfFirst(null)).not.toThrow();
	});
});

describe('focusOnMountIfFirstChoice', () => {
	/**
	 * A box in a `label`, with what is before the label.
	 * @param previous - What `previousElementSibling` of its label is
	 * @example
	 * ```ts
	 * box(null).focused; // 0
	 * ```
	 */
	function box(previous: object | null) {
		const element = {
			focused: 0,
			focus() {
				element.focused += 1;
			},
			closest: (selector: string) =>
				selector === 'label' ? { previousElementSibling: previous } : null,
		};
		return element;
	}

	test('gives the focus to the box of the first choice only', () => {
		const first = box(null);
		const second = box({});
		focusOnMountIfFirstChoice(first as unknown as HTMLElement);
		focusOnMountIfFirstChoice(second as unknown as HTMLElement);
		expect([first.focused, second.focused]).toStrictEqual([1, 0]);
	});

	test('does nothing when the box is unmounted', () => {
		expect(() => focusOnMountIfFirstChoice(null)).not.toThrow();
	});
});
