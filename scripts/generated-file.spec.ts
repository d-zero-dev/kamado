import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
	committedVersion,
	importGenerator,
	unformatted,
} from './generated-file.test-util.js';

describe('committedVersion', () => {
	const header = /^\/\/ Source: prettier (\S+) /mu;

	test.each([
		['the first line', '// Source: prettier 3.9.6 (plugins/html.mjs).\n'],
		['the second line', '// @generated\n// Source: prettier 3.9.6 (plugins/html.mjs).\n'],
		[
			'a later line',
			'// @generated\n//\n//\n// Source: prettier 3.9.6 (x).\nfn a() {}\n',
		],
	])('reads the version from the header on %s', (_, text) => {
		expect(committedVersion(text, header)).toBe('3.9.6');
	});

	test('fails, naming the header, when no line matches', () => {
		expect(() => committedVersion('// Source: esbuild 0.28.1 (x).\n', header)).toThrow(
			`no header line matches ${header}`,
		);
	});
});

describe('unformatted', () => {
	test('is the same for the code before and after cargo fmt', () => {
		expect(unformatted('pub static A: [&str; 2] = [\n\t"a",\n\t"b",\n];\n')).toBe(
			unformatted('pub static A: [&str; 2] = ["a", "b"];'),
		);
	});

	test('keeps the white space and the commas inside a string literal', () => {
		expect(unformatted('("a , ]", "\\" ,)")')).toBe('("a , ]","\\" ,)")');
	});
});

describe('importGenerator', () => {
	let dir: string;
	let output: string;
	const table = 'export const TABLE = 1;\n';

	beforeAll(() => {
		dir = mkdtempSync(path.join(tmpdir(), 'kamado-import-generator-'));
		output = path.join(dir, 'table.mjs');
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const generator = (name: string, body: string) => {
		const file = path.join(dir, name);
		writeFileSync(file, body);
		return file;
	};

	test('tells a generator that writes on import, even the contents that are there', () => {
		writeFileSync(output, table);
		const writing = generator(
			'writing.mjs',
			`import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(output)}, ${JSON.stringify(table)});\n`,
		);
		expect(importGenerator(writing, [output])).toEqual({
			status: 0,
			stdout: '',
			changed: [output],
		});
	});

	test('tells nothing of a generator that writes nothing on import', () => {
		writeFileSync(output, table);
		const quiet = generator('quiet.mjs', 'export const generate = () => {};\n');
		expect(importGenerator(quiet, [output])).toEqual({
			status: 0,
			stdout: '',
			changed: [],
		});
	});

	test('leaves the output with its contents while the generator runs, as others read it', () => {
		writeFileSync(output, table);
		const reading = generator(
			'reading.mjs',
			`import { readFileSync } from 'node:fs';\nprocess.stdout.write(readFileSync(${JSON.stringify(output)}, 'utf8'));\n`,
		);
		expect(importGenerator(reading, [output]).stdout).toBe(table);
	});

	test('gives the output its modification time back', () => {
		writeFileSync(output, table);
		const before = statSync(output).mtimeMs;
		const quiet = generator('quiet-again.mjs', 'export const generate = () => {};\n');
		importGenerator(quiet, [output]);
		// A time that was not put back is the epoch, years away: what is compared is the second,
		// because a time of seconds as a float is not exact to the millisecond on every file system.
		expect(Math.abs(statSync(output).mtimeMs - before)).toBeLessThan(1000);
	});

	test('tells only the outputs that the generator wrote, and gives each its time and contents back', () => {
		const other = path.join(dir, 'other.mjs');
		const past = 1_000_000_000;
		writeFileSync(output, table);
		writeFileSync(other, 'export const OTHER = 2;\n');
		utimesSync(output, past, past);
		utimesSync(other, past, past);
		const writing = generator(
			'writing-one.mjs',
			`import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(other)}, 'changed\\n');\n`,
		);
		expect(importGenerator(writing, [output, other])).toEqual({
			status: 0,
			stdout: '',
			changed: [other],
		});
		expect(readFileSync(output, 'utf8')).toBe(table);
		expect(readFileSync(other, 'utf8')).toBe('export const OTHER = 2;\n');
		expect(Math.abs(statSync(output).mtimeMs - past * 1000)).toBeLessThan(1000);
		expect(Math.abs(statSync(other).mtimeMs - past * 1000)).toBeLessThan(1000);
	});

	test('gives the output the contents it had when the generator wrote on import', () => {
		writeFileSync(output, table);
		const writing = generator(
			'writing-other.mjs',
			`import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(output)}, 'changed\\n');\n`,
		);
		importGenerator(writing, [output]);
		expect(readFileSync(output, 'utf8')).toBe(table);
	});
});
