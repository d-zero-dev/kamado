import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import { ResetDialog } from './reset-dialog.js';

/**
 * The dialog as HTML.
 * @param open - Whether the question is asked
 */
function render(open: boolean): string {
	return renderToStaticMarkup(
		<ResetDialog open={open} onConfirm={() => {}} onCancel={() => {}} />,
	);
}

describe('the dialog that asks before the settings go back to the defaults', () => {
	test('says what goes: the columns, the order of the rows, the rows per page, the choice columns', () => {
		const html = render(true);
		expect(html).toContain('Reset to defaults');
		expect(html).toContain('The order, the pinned columns and the widths of the columns');
		expect(html).toContain('The order of the rows');
		expect(html).toContain('The rows per page');
		expect(html).toContain('The columns that choose among options');
	});

	test('says what stays and that it is not undone', () => {
		expect(render(true)).toContain('The pages and the language do not change.');
		expect(render(true)).toContain('This cannot be undone.');
	});

	test('the focus starts on Cancel and on nothing else', () => {
		const html = render(true);
		expect(html.match(/autofocus/g)).toHaveLength(1);
		expect(html).toMatch(/<button[^>]*autofocus[^>]*>Cancel<\/button>/);
		expect(html).toMatch(/<button[^>]*>Reset<\/button>/);
		expect(html).not.toMatch(/<button[^>]*autofocus[^>]*>Reset<\/button>/);
	});

	test('is named by its own heading', () => {
		const html = render(true);
		expect(html).toContain('aria-labelledby="reset-title"');
		expect(html).toContain('<h2 id="reset-title">');
	});

	test('holds nothing while it is not asked', () => {
		const html = render(false);
		expect(html).not.toContain('<h2');
		expect(html).not.toContain('<button');
	});
});
