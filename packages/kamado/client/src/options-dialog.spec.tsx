import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import { OptionsDialog } from './options-dialog.js';

describe('the options dialog', () => {
	test('names the column by the name it is given, not by its key', () => {
		const html = renderToStaticMarkup(
			<OptionsDialog
				column="meta:title"
				name="Page title"
				initial={['a']}
				kinds={{}}
				onSave={() => {}}
				onClose={() => {}}
			/>,
		);
		expect(html).toContain('Options of Page title');
		expect(html).not.toContain('Options of title');
	});

	test('sends commands to an element that is in the output: the screen’s own ones, or those of a dialog', () => {
		const html = renderToStaticMarkup(
			<OptionsDialog
				column="meta:title"
				name="Page title"
				initial={['a']}
				kinds={{}}
				onSave={() => {}}
				onClose={() => {}}
			/>,
		);
		const buttons = (html.match(/<button[^>]*>/g) ?? []).filter((button) =>
			button.includes('commandfor='),
		);
		expect(buttons.length).toBeGreaterThan(1);
		for (const button of buttons) {
			const target = /commandfor="([^"]*)"/.exec(button)?.[1];
			const command = /\scommand="([^"]*)"/.exec(button)?.[1];
			expect(target).toBeDefined();
			expect(html).toContain(` id="${target}"`);
			expect(command).toMatch(/^(--.|close$|show-modal$)/);
		}
	});
});
