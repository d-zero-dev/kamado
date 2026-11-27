import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { checkOutName, writeOutFile } from './out-file.js';

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), 'kd-out-file-'));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe('checkOutName', () => {
	test('refuses an empty name, which is the directory the command runs in', () => {
		expect(() => checkOutName('')).toThrow('--out needs a file name');
	});

	test('takes a name, and no name', () => {
		expect(() => checkOutName('changes.txt')).not.toThrow();
		expect(() => checkOutName()).not.toThrow();
	});
});

describe('writeOutFile', () => {
	test('writes relative to the directory it is given, and makes the directory the file is in', () => {
		writeOutFile(dir, 'maps/deeper/changes.txt', 'text\n');
		expect(readFileSync(path.join(dir, 'maps', 'deeper', 'changes.txt'), 'utf8')).toBe(
			'text\n',
		);
	});

	test('writes to an absolute name as it is', () => {
		const file = path.join(dir, 'absolute.txt');
		writeOutFile('/not/the/directory', file, 'text\n');
		expect(readFileSync(file, 'utf8')).toBe('text\n');
	});

	test('writes over the file that is there', () => {
		writeOutFile(dir, 'changes.txt', 'one\n');
		writeOutFile(dir, 'changes.txt', 'two\n');
		expect(readFileSync(path.join(dir, 'changes.txt'), 'utf8')).toBe('two\n');
	});

	test('says what was typed and why when the file cannot be written, and keeps the cause', () => {
		// a directory is where the file is
		writeOutFile(dir, 'there/changes.txt', 'x');
		let error: Error | undefined;
		try {
			writeOutFile(dir, 'there', 'x');
		} catch (error_) {
			error = error_ as Error;
		}
		expect(error?.message).toMatch(/^cannot write there: .*EISDIR/u);
		expect(error?.cause).toBeInstanceOf(Error);
		// a file is where a directory has to be
		writeFileSync(path.join(dir, 'file'), 'x');
		expect(() => writeOutFile(dir, 'file/changes.txt', 'x')).toThrow(
			/^cannot write file\/changes\.txt: /u,
		);
		expect(existsSync(path.join(dir, 'file', 'changes.txt'))).toBe(false);
	});
});
