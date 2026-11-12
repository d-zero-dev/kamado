import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { COLUMN_DEFAULTS_PLACEHOLDER, TOKEN_PLACEHOLDER } from './app.js';

const INDEX = path.resolve(import.meta.dirname, '..', '..', 'client', 'index.html');

describe('the page of the screen (client/index.html)', () => {
	test('carries the token where the server puts it, and the screen reads it', async () => {
		const html = await readFile(INDEX, 'utf8');
		expect(html).toContain(`<meta name="kamado-token" content="${TOKEN_PLACEHOLDER}" />`);
	});

	test('carries the column defaults where the server puts them, under the name the screen reads', async () => {
		const html = await readFile(INDEX, 'utf8');
		expect(html).toContain(
			`<meta name="kamado-column-defaults" content="${COLUMN_DEFAULTS_PLACEHOLDER}" />`,
		);
		// The screen asks the page for this name (`columnDefaults` of `client/src/api.ts`).
		const api = await readFile(
			path.resolve(import.meta.dirname, '..', '..', 'client', 'src', 'api.ts'),
			'utf8',
		);
		expect(api).toContain(`meta[name="kamado-column-defaults"]`);
	});
});
