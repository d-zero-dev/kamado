import { describe, expect, test } from 'vitest';

import { ids, lint } from '../lint.test-util.js';

const RULE = 'no-ignored-props';

describe(RULE, () => {
	test.each([
		['<div ref={ref} />', 'ref'],
		['<div ref={(el) => {}} />', 'ref'],
		['<input ref={null} />', 'ref'],
		['<my-element ref={ref} />', 'ref'],
		['<div suppressHydrationWarning />', 'suppressHydrationWarning'],
		['<time suppressHydrationWarning={true} />', 'suppressHydrationWarning'],
		[
			'<div contentEditable suppressContentEditableWarning />',
			'suppressContentEditableWarning',
		],
		['<p suppressContentEditableWarning={true} />', 'suppressContentEditableWarning'],
	])('invalid: %s', (code, prop) => {
		const messageId = {
			ref: 'noIgnoredRef',
			suppressHydrationWarning: 'noIgnoredHydration',
			suppressContentEditableWarning: 'noIgnoredContentEditable',
		}[prop];
		expect(ids(RULE, code)).toStrictEqual([messageId]);
	});

	test.each([
		['<List ref={ref} />'],
		['<List.Item ref={ref} />'],
		['<Time suppressHydrationWarning />'],
		['<Editor suppressContentEditableWarning />'],
		['<div contentEditable />'],
		['<div key={i} />'],
		['<div className="ref" />'],
		['<div data-ref={ref} />'],
		['<div refs={ref} />'],
		['<div {...rest} />'],
	])('valid: %s', (code) => {
		expect(ids(RULE, code)).toStrictEqual([]);
	});

	test('the report is on the attribute', () => {
		expect(lint(RULE, '<div id="a" ref={r} />')).toStrictEqual([
			{ messageId: 'noIgnoredRef', line: 1, column: 13 },
		]);
	});
});
