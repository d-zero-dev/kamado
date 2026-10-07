import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { generateJsxFixtures } from './generate-jsx-fixtures.ts';

describe('generateJsxFixtures', () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), 'kamado-fixtures-'));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const listPages = (dir: string): string[] =>
		readdirSync(path.join(dir, 'input', 'pages'), { recursive: true })
			.map(String)
			.filter((f) => f.endsWith('.tsx'))
			.toSorted();

	test('writes one page file per requested page, zero-padded to the widest index', () => {
		generateJsxFixtures({ pages: 120, seed: 1, outDir: root });

		const pages = listPages(root);

		expect(pages).toHaveLength(120);
		expect(pages).toContain(path.join('section-0', 'page-000.tsx'));
		expect(pages).toContain(path.join('section-19', 'page-119.tsx'));
	});

	test('the same seed and page count produce byte-identical files', () => {
		const a = path.join(root, 'a');
		const b = path.join(root, 'b');

		generateJsxFixtures({ pages: 30, seed: 7, outDir: a });
		generateJsxFixtures({ pages: 30, seed: 7, outDir: b });

		const file = path.join('input', 'pages', 'section-5', 'page-05.tsx');
		expect(readFileSync(path.join(a, file), 'utf8')).toBe(
			readFileSync(path.join(b, file), 'utf8'),
		);
	});

	test('a different seed produces different page content', () => {
		const a = path.join(root, 'a');
		const b = path.join(root, 'b');

		generateJsxFixtures({ pages: 30, seed: 1, outDir: a });
		generateJsxFixtures({ pages: 30, seed: 2, outDir: b });

		const file = path.join('input', 'pages', 'section-5', 'page-05.tsx');
		expect(readFileSync(path.join(a, file), 'utf8')).not.toBe(
			readFileSync(path.join(b, file), 'utf8'),
		);
	});

	test('every page declares a literal `meta` export as required by the RFC', () => {
		generateJsxFixtures({ pages: 10, seed: 1, outDir: root });

		const page = readFileSync(
			path.join(root, 'input', 'pages', 'section-0', 'page-0.tsx'),
			'utf8',
		);

		expect(page).toMatch(
			/export const meta = \{\n\ttitle: ".+",\n\tdescription: ".+",\n\tlayout: 'default',\n\} as const;/,
		);
	});

	test('shared layout, components, images, css and scripts are written', () => {
		generateJsxFixtures({ pages: 1, seed: 1, outDir: root });

		const files = readdirSync(path.join(root, 'input'), { recursive: true })
			.map(String)
			.filter((f) => !f.startsWith('pages'));

		expect(files).toEqual(
			expect.arrayContaining([
				path.join('_libs', 'layouts', 'default.tsx'),
				path.join('_libs', 'components', 'card.tsx'),
				path.join('img', 'a.png'),
				path.join('css', 'style.css'),
				path.join('js', 'app.ts'),
			]),
		);
	});

	test.each([
		[0, 1, 'pages must be a positive integer: 0'],
		[1.5, 1, 'pages must be a positive integer: 1.5'],
		[10, 0.5, 'seed must be an integer: 0.5'],
	])('pages=%s seed=%s is rejected with a clear message', (pages, seed, message) => {
		expect(() => generateJsxFixtures({ pages, seed, outDir: root })).toThrow(message);
	});
});
