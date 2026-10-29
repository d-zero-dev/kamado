import { describe, expect, test } from 'vitest';

import { ELEMENT_BOOLEAN_PROPS, PROPS } from './attr-table.js';

describe('ELEMENT_BOOLEAN_PROPS', () => {
	test('lists the boolean props that React writes in the code of one element', () => {
		expect(ELEMENT_BOOLEAN_PROPS).toEqual([
			['input', 'checked'],
			['option', 'selected'],
		]);
	});

	test('has no prop of the table of the generic path, which writes them on any element', () => {
		const generic = new Set(PROPS.map(([prop]) => prop));
		for (const [, prop] of ELEMENT_BOOLEAN_PROPS) {
			expect(generic.has(prop)).toBe(false);
		}
	});
});
