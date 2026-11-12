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
});
