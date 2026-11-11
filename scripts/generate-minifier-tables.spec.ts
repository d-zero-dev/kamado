import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { generate, readSources, renderTables } from './generate-minifier-tables.mjs';
import { committedVersion, importGenerator } from './generated-file.test-util.js';

const root = path.resolve(import.meta.dirname, '..');
const committed = path.join(root, 'crates', 'kd_html', 'src', 'minify', 'tables.rs');

describe('generate-minifier-tables', () => {
	test('html-minifier-terser is the version package.json declares', () => {
		const declared: string = JSON.parse(
			readFileSync(path.join(root, 'package.json'), 'utf8'),
		).devDependencies['html-minifier-terser'];
		expect(readSources().version).toBe(declared);
	});

	test('tables.rs is what the generator writes for the installed html-minifier-terser, apart from the version in the header', () => {
		const text = readFileSync(committed, 'utf8');
		const version = committedVersion(text, /^\/\/ Source: html-minifier-terser (\S+) /mu);
		// If this fails after html-minifier-terser was upgraded: node scripts/generate-minifier-tables.mjs
		expect(renderTables(readSources().source, version)).toBe(text);
	});

	test('the table says which html-minifier-terser it was made from', () => {
		expect(renderTables(readSources().source, '9.9.9').split('\n')[1]).toBe(
			'// Source: html-minifier-terser 9.9.9 (src/htmlparser.js, the NCName character classes).',
		);
	});

	test('a parser without a character class makes the generator fail', () => {
		expect(() => renderTables('', '1.0.0')).toThrow('combiningChar not found');
	});

	test('running the generator writes the table to its file', () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'kamado-minifier-tables-'));
		try {
			const output = path.join(dir, 'tables.rs');
			generate(output);
			const { source, version } = readSources();
			expect(readFileSync(output, 'utf8')).toBe(renderTables(source, version));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('importing the generator writes nothing', () => {
		expect(
			importGenerator(path.join(root, 'scripts', 'generate-minifier-tables.mjs'), [
				committed,
			]),
		).toEqual({ status: 0, stdout: '', changed: [] });
	});
});
