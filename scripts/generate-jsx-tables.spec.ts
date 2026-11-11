import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { generate, OUTPUTS, readSources, renderTables } from './generate-jsx-tables.mjs';
import {
	committedVersion,
	importGenerator,
	unformatted,
} from './generated-file.test-util.js';

const root = path.resolve(import.meta.dirname, '..');
const committedTs = path.join(root, 'packages', 'kamado', 'src', 'jsx', 'attr-table.ts');
const committedRust = path.join(root, 'crates', 'kd_js', 'src', 'react_attrs.rs');

describe('generate-jsx-tables', () => {
	test('react-dom is the version package.json declares', () => {
		const declared: string = JSON.parse(
			readFileSync(path.join(root, 'package.json'), 'utf8'),
		).devDependencies['react-dom'];
		expect(readSources().version).toBe(declared);
	});

	test('attr-table.ts is what the generator writes for the installed react-dom, apart from the version in the header', () => {
		const committed = readFileSync(committedTs, 'utf8');
		const version = committedVersion(committed, /^\/\/ Source: react-dom (\S+) /mu);
		// If this fails after react-dom was upgraded: node scripts/generate-jsx-tables.mjs
		expect(renderTables(readSources().source, version).ts).toBe(committed);
	});

	test('react_attrs.rs is what the generator writes for the installed react-dom, apart from the version in the header', () => {
		const committed = readFileSync(committedRust, 'utf8');
		const version = committedVersion(committed, /^\/\/! Source: react-dom (\S+) /mu);
		// If this fails after react-dom was upgraded: node scripts/generate-jsx-tables.mjs
		expect(unformatted(renderTables(readSources().source, version).rust)).toBe(
			unformatted(committed),
		);
	});

	test('the tables say which react-dom they were made from', () => {
		const { ts, rust } = renderTables(readSources().source, '9.9.9');
		expect(ts.split('\n')[1]).toBe(
			'// Source: react-dom 9.9.9 (cjs/react-dom-server-legacy.node.production.js), read as',
		);
		expect(rust.split('\n')[1]).toBe(
			'//! Source: react-dom 9.9.9 (cjs/react-dom-server-legacy.node.production.js), read as',
		);
	});

	test('a server build without the tables makes the generator fail', () => {
		expect(() => renderTables('', '1.0.0')).toThrow('marker not found');
	});

	test('running the generator writes each table to its file', () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'kamado-jsx-tables-'));
		try {
			const outputs = {
				ts: path.join(dir, 'src', 'attr-table.ts'),
				rust: path.join(dir, 'react_attrs.rs'),
			};
			generate(outputs);
			const { source, version } = readSources();
			const tables = renderTables(source, version);
			expect(readFileSync(outputs.ts, 'utf8')).toBe(tables.ts);
			expect(readFileSync(outputs.rust, 'utf8')).toBe(tables.rust);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('the generator writes the committed files when it is run', () => {
		expect(OUTPUTS).toEqual({ ts: committedTs, rust: committedRust });
	});

	test('importing the generator writes nothing', () => {
		expect(
			importGenerator(path.join(root, 'scripts', 'generate-jsx-tables.mjs'), [
				committedTs,
				committedRust,
			]),
		).toEqual({ status: 0, stdout: '', changed: [] });
	});
});
