import { describe, expect, test } from 'vitest';

import { ids, lint } from '../lint.test-util.js';

const RULE = 'no-client-directive';

describe(RULE, () => {
	test.each([
		["'use client';\nexport default () => null;"],
		['"use client";\nexport default () => null;'],
		["'use server';\nexport default () => null;"],
		["export async function action() {\n\t'use server';\n}"],
		["const f = () => {\n\t'use client';\n};"],
	])('invalid: %s', (code) => {
		expect(ids(RULE, code)).toStrictEqual(['noClientDirective']);
	});

	test.each([
		["'use strict';\nexport default () => null;"],
		["export default () => null;\n'use client';"],
		["const text = 'use client';"],
		["call('use client');"],
		["const o = { 'use client': 1 };"],
		["export default () => 'use server';"],
	])('valid: %s', (code) => {
		expect(ids(RULE, code)).toStrictEqual([]);
	});

	test('the report is on the directive', () => {
		expect(lint(RULE, "'use strict';\n'use client';\n")).toStrictEqual([
			{ messageId: 'noClientDirective', line: 2, column: 1 },
		]);
	});
});
