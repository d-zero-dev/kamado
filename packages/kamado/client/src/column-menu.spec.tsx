import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import { ColumnMenu } from './column-menu.js';

const menu = {
	label: 'Menu of title',
	anchor: { left: 0, bottom: 0 },
	items: [{ id: 'pin', label: 'Pin' }],
	onChoose: () => {},
	onClose: () => {},
};

describe('the note of the column menu', () => {
	test('is drawn as text above the entries', () => {
		const html = renderToStaticMarkup(
			<ColumnMenu {...menu} note={'title\nUsed for <title>'} />,
		);
		expect(html).toContain('class="note"');
		expect(html.indexOf('class="note"')).toBeLessThan(html.indexOf('<button'));
		// the text of the config is text: its markup is escaped, and its lines are kept for CSS
		expect(html).toContain('Used for &lt;title&gt;');
		expect(html).not.toContain('<title>');
		expect(html).toContain('title\nUsed for');
	});

	test('describes the menu to people who cannot see it', () => {
		const html = renderToStaticMarkup(<ColumnMenu {...menu} note="What it is for" />);
		const id = /aria-describedby="([^"]+)"/.exec(html)?.[1];
		expect(id).toBeDefined();
		expect(html).toContain(`id="${id}"`);
	});

	test('is not among the children of the element with role="menu", which are its entries', () => {
		const html = renderToStaticMarkup(<ColumnMenu {...menu} note="What it is for" />);
		expect(html.indexOf('class="note"')).toBeLessThan(html.indexOf('role="menu"'));
		const inside = /<div role="menu"[^>]*>(.*)<\/div><\/div>$/s.exec(html)?.[1];
		expect(inside).toBeDefined();
		expect(inside).not.toContain('<p');
		expect(inside).toContain('role="menuitem"');
	});

	test('is not drawn without a note, and the menu describes nothing', () => {
		const html = renderToStaticMarkup(<ColumnMenu {...menu} />);
		expect(html).not.toContain('class="note"');
		expect(html).not.toContain('aria-describedby');
		expect(html).toContain('role="menuitem"');
	});
});

describe('the buttons of the column menu', () => {
	test('send the screen’s own commands to an element that is in the output', () => {
		const html = renderToStaticMarkup(<ColumnMenu {...menu} note="What it is for" />);
		const buttons = html.match(/<button[^>]*>/g) ?? [];
		expect(buttons.length).toBeGreaterThan(0);
		for (const button of buttons) {
			const target = /commandfor="([^"]*)"/.exec(button)?.[1];
			const command = /\scommand="([^"]*)"/.exec(button)?.[1];
			expect(target).toBeDefined();
			expect(html).toContain(` id="${target}"`);
			expect(command).toMatch(/^--./);
		}
	});
});
