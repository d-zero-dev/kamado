import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, test } from 'vitest';

import { isMain } from './is-main.mjs';

describe('isMain', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'kamado-is-main-'));
	const file = path.join(dir, 'script.mjs');
	writeFileSync(file, '');
	const link = path.join(dir, 'link.mjs');
	symlinkSync(file, link);
	// `import.meta.filename` is the resolved path (on macOS the temporary directory
	// is reached through `/var` → `/private/var`).
	const filename = realpathSync(file);

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test('is true for the file Node was started with, through a symbolic link too', () => {
		expect(isMain(filename, file)).toBe(true);
		expect(isMain(filename, link)).toBe(true);
	});

	test('is false for another file, for no path and for a path of no file', () => {
		expect(isMain(filename, path.join(dir, 'other.mjs'))).toBe(false);
		expect(isMain(filename)).toBe(false);
		expect(isMain(filename, '')).toBe(false);
		expect(isMain(filename, path.join(dir, 'missing.mjs'))).toBe(false);
	});
});
