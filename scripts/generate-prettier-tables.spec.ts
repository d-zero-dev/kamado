import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, test } from 'vitest';

import {
	readSources,
	renderElementTables,
	renderEntityNames,
} from './generate-prettier-tables.mjs';

const root = path.resolve(import.meta.dirname, '..');
const print = path.join(root, 'crates', 'kd_html', 'src', 'print');

// `tables.rs` is formatted by `cargo fmt --all` after the generator wrote it,
// which only moves white space and trailing commas outside the string literals.
const unformatted = (rust: string): string =>
	rust
		.replaceAll(/("(?:[^"\\]|\\.)*")|\s+/gu, '$1')
		.replaceAll(/("(?:[^"\\]|\\.)*")|,(?=[)\]])/gu, '$1');

describe('generate-prettier-tables', () => {
	test('prettier-v2 is the version package.json declares', () => {
		const declared: string = JSON.parse(
			readFileSync(path.join(root, 'package.json'), 'utf8'),
		).devDependencies['prettier-v2'];
		expect(declared).toMatch(/^npm:prettier@\d+\.\d+\.\d+$/u);
		expect(readSources().version).toBe(declared.slice(declared.lastIndexOf('@') + 1));
	});

	test('tables.rs is what the generator writes for the installed prettier-v2', () => {
		const { source, version } = readSources();
		const committed = readFileSync(path.join(print, 'tables.rs'), 'utf8');
		// If this fails after prettier-v2 was changed: node scripts/generate-prettier-tables.mjs
		expect(unformatted(renderElementTables(source, version).text)).toBe(
			unformatted(committed),
		);
	});

	test('entity_names.rs is what the generator writes for the installed prettier-v2', () => {
		const { source, version } = readSources();
		const committed = readFileSync(path.join(print, 'entity_names.rs'), 'utf8');
		// If this fails after prettier-v2 was changed: node scripts/generate-prettier-tables.mjs
		expect(renderEntityNames(source, version).text).toBe(committed);
	});

	test('ngsp, which the lexer adds after its table, is a known reference', () => {
		const { source, version } = readSources();
		expect(renderEntityNames(source, version).text).toContain('\t"ngsp",\n');
	});

	test('the tables say which prettier they were made from', () => {
		const { source } = readSources();
		expect(renderElementTables(source, '9.9.9').text.split('\n')[1]).toBe(
			'// Source: prettier 9.9.9 (plugins/html.mjs).',
		);
		expect(renderEntityNames(source, '9.9.9').text.split('\n')[1]).toBe(
			"// Source: prettier 9.9.9 (plugins/html.mjs, the lexer's named character references).",
		);
	});

	describe('a prettier whose structure changed makes the generator fail', () => {
		const elements = '["a","abbr","acronym","address","applet","area"]';
		const attributes = 'new Map([["*",new Set(["accesskey"])]])';

		test('without the tables', () => {
			expect(() => renderElementTables('', '1.0.0')).toThrow('anchor not found');
		});

		test('with tables of an unexpected size', () => {
			expect(() =>
				renderElementTables(`${attributes};new Set(${elements})`, '1.0.0'),
			).toThrow('the tables have an unexpected shape');
		});

		test('without the character references', () => {
			expect(() => renderEntityNames('', '1.0.0')).toThrow(
				'the entity table was not found',
			);
		});

		test('with character references of an unexpected size', () => {
			expect(() =>
				renderEntityNames('{AElig:"\\u00C6",zwnj:"\\u200C"};_e.ngsp="\\uE500"', '1.0.0'),
			).toThrow('the entity table has an unexpected size');
		});

		test('with a lexer that does not add ngsp', () => {
			expect(() =>
				renderEntityNames('{AElig:"\\u00C6",zwnj:"\\u200C"}', '1.0.0'),
			).toThrow('the lexer does not add ngsp');
		});
	});

	test('importing the generator writes nothing', () => {
		const url = pathToFileURL(
			path.join(root, 'scripts', 'generate-prettier-tables.mjs'),
		).href;
		const run = spawnSync(
			process.execPath,
			['--input-type=module', '--eval', `await import(${JSON.stringify(url)});`],
			{ encoding: 'utf8' },
		);
		expect(run.status).toBe(0);
		expect(run.stdout).toBe('');
	});
});
