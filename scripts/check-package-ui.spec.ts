import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
	assetsOf,
	emptyUiFiles,
	legalFileOf,
	missingUiFiles,
	TOKEN_PLACEHOLDER,
	UI_FILES,
} from './check-package-ui.mjs';

const SCRIPT = path.join(import.meta.dirname, 'check-package-ui.mjs');
const PAGE = `<meta name="kamado-token" content="${TOKEN_PLACEHOLDER}"><link rel="stylesheet" href="/assets/app.css"><script type="module" src="/assets/app.js"></script>`;

const made: string[] = [];

afterEach(() => {
	for (const root of made.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

/**
 * An unpacked package with the listed files of the screen (`index.html` holding `page`, the
 * others holding a byte).
 * @param files - The files, from the package root
 * @param page - What `index.html` holds
 * @param empty - Files that are written empty
 * @param bundle
 */
function unpacked(
	files: readonly string[],
	page: string = PAGE,
	empty: readonly string[] = [],
	bundle = 'x',
) {
	const root = mkdtempSync(path.join(tmpdir(), 'check-ui-'));
	made.push(root);
	for (const file of files) {
		mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		writeFileSync(
			path.join(root, file),
			empty.includes(file)
				? ''
				: file.endsWith('.html')
					? page
					: file.endsWith('app.js')
						? bundle
						: 'x',
		);
	}
	return root;
}

/**
 * Runs the script on a package directory.
 * @param root - The package directory
 */
function run(root: string) {
	return spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });
}

describe('missingUiFiles', () => {
	test('nothing is missing when the package has them all', () => {
		expect(missingUiFiles(() => true)).toEqual([]);
	});
	test('the files it lacks are listed', () => {
		expect(missingUiFiles((file) => file !== 'dist/ui/assets/app.js')).toEqual([
			'dist/ui/assets/app.js',
		]);
	});
});

describe('legalFileOf', () => {
	test('is the file the bundle ends by naming', () => {
		expect(
			legalFileOf('x;\n/*! For license information please see app.js.LEGAL.txt */'),
		).toBe('dist/ui/assets/app.js.LEGAL.txt');
	});
	test('is nothing for a bundle that names none (no bundled code had a licence comment)', () => {
		expect(legalFileOf('x;')).toBeNull();
	});
});

describe('emptyUiFiles', () => {
	test('lists the files with no bytes', () => {
		expect(emptyUiFiles((file) => (file.endsWith('.css') ? 0 : 10))).toEqual([
			'dist/ui/assets/app.css',
		]);
	});
});

describe('assetsOf', () => {
	test('the files the page asks for, from the package root', () => {
		expect(assetsOf(PAGE)).toEqual(['dist/ui/assets/app.css', 'dist/ui/assets/app.js']);
	});
	test('quotes of either kind', () => {
		expect(assetsOf("<script src='/assets/a.js'></script>")).toEqual([
			'dist/ui/assets/a.js',
		]);
	});
	test('a page that asks for nothing under /assets asks for nothing', () => {
		expect(assetsOf('<a href="/other/x.css">')).toEqual([]);
	});
});

describe('check-package-ui', () => {
	test('a package with the screen passes', () => {
		const result = run(unpacked(UI_FILES));
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('ok: the screen of kamado ui is in the package');
	});
	test('a package without the screen fails and names the files', () => {
		const result = run(unpacked([]));
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('dist/ui/index.html');
	});
	test('a bundle that names a licence file the package lacks fails', () => {
		const result = run(
			unpacked(
				UI_FILES,
				PAGE,
				[],
				'x;\n/*! For license information please see app.js.LEGAL.txt */',
			),
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('app.js.LEGAL.txt');
	});
	test('a bundle that names a licence file the package has passes', () => {
		const result = run(
			unpacked(
				[...UI_FILES, 'dist/ui/assets/app.js.LEGAL.txt'],
				PAGE,
				[],
				'x;\n/*! For license information please see app.js.LEGAL.txt */',
			),
		);
		expect(result.status).toBe(0);
	});
	test('a screen with an empty bundle fails', () => {
		const result = run(unpacked(UI_FILES, PAGE, ['dist/ui/assets/app.js']));
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('empty files: dist/ui/assets/app.js');
	});
	test('a page without the place of the token fails, for every write would be refused', () => {
		const result = run(unpacked(UI_FILES, '<script src="/assets/app.js"></script>'));
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(TOKEN_PLACEHOLDER);
	});
	test('a page that asks for a file that is not there fails', () => {
		const result = run(
			unpacked(
				UI_FILES,
				`<meta content="${TOKEN_PLACEHOLDER}"><script type="module" src="/assets/other.js"></script>`,
			),
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('dist/ui/assets/other.js');
	});
	test('a missing directory argument is a usage error', () => {
		const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
		expect(result.status).toBe(2);
		expect(result.stderr).toContain('Usage:');
	});
});
