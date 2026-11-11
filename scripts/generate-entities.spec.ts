import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { generate, readSources, renderEntities } from './generate-entities.mjs';
import {
	committedVersion,
	importGenerator,
	unformatted,
} from './generated-file.test-util.js';

const root = path.resolve(import.meta.dirname, '..');
const committed = path.join(root, 'crates', 'kd_html', 'src', 'entities_table.rs');

describe('generate-entities', () => {
	test('character-entities is the version package.json declares', () => {
		const declared: string = JSON.parse(
			readFileSync(path.join(root, 'package.json'), 'utf8'),
		).devDependencies['character-entities'];
		expect(readSources().version).toBe(declared);
	});

	test('entities_table.rs is what the generator writes for the installed character-entities, apart from the version in the header', () => {
		const text = readFileSync(committed, 'utf8');
		const version = committedVersion(text, /^\/\/ Source: character-entities (\S+) /mu);
		// If this fails after character-entities was upgraded: node scripts/generate-entities.mjs
		expect(unformatted(renderEntities({ ...readSources(), version }).text)).toBe(
			unformatted(text),
		);
	});

	test('the table says which character-entities it was made from', () => {
		expect(
			renderEntities({ ...readSources(), version: '9.9.9' }).text.split('\n')[1],
		).toBe('// Source: character-entities 9.9.9 (WHATWG named character references).');
	});

	test('references without a legacy name make the generator fail', () => {
		expect(() => renderEntities({ entities: { amp: '&' }, version: '1.0.0' })).toThrow(
			'the legacy list must have 106 entries, all of them known names',
		);
	});

	test('running the generator writes the table to its file and reports it', () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'kamado-entities-'));
		try {
			const output = path.join(dir, 'entities_table.rs');
			const report = generate(output);
			const { text, names } = renderEntities(readSources());
			expect(readFileSync(output, 'utf8')).toBe(text);
			expect(report).toContain(`: ${names} names, 106 legacy, `);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('importing the generator writes nothing', () => {
		expect(
			importGenerator(path.join(root, 'scripts', 'generate-entities.mjs'), [committed]),
		).toEqual({ status: 0, stdout: '', changed: [] });
	});
});
