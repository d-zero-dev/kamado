import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, test } from 'vitest';

import { readSources, renderJsxEntities } from './generate-jsx-entities.mjs';

const root = path.resolve(import.meta.dirname, '..');

describe('generate-jsx-entities', () => {
	test('esbuild-v2 is the version package.json declares', () => {
		const declared: string = JSON.parse(
			readFileSync(path.join(root, 'package.json'), 'utf8'),
		).devDependencies['esbuild-v2'];
		expect(declared).toMatch(/^npm:esbuild@\d+\.\d+\.\d+$/u);
		expect(readSources().version).toBe(declared.slice(declared.lastIndexOf('@') + 1));
	});

	// The generator asks esbuild about each of the 2000+ names.
	test(
		'jsx_entities.rs is what the generator writes for the installed esbuild-v2',
		{ timeout: 60_000 },
		() => {
			const committed = readFileSync(
				path.join(root, 'crates', 'kd_js', 'src', 'jsx_entities.rs'),
				'utf8',
			);
			// If this fails after esbuild-v2 was changed: node scripts/generate-jsx-entities.mjs
			expect(renderJsxEntities(readSources()).text).toBe(committed);
		},
	);

	test('the table holds the names JSX decodes, and says which esbuild knows them', () => {
		const { text, count } = renderJsxEntities({
			names: ['amp', 'AMP', 'nbsp'],
			version: '9.9.9',
		});
		// JSX knows the HTML 4 names, not `AMP` of HTML 5.
		expect(count).toBe(2);
		expect(text.split('\n')[1]).toBe(
			'// Source: esbuild 9.9.9 (the named references its JSX parser decodes).',
		);
		expect(text).toContain('("amp", "\\u{26}")');
		expect(text).not.toContain('"AMP"');
	});

	test('importing the generator writes nothing', () => {
		const url = pathToFileURL(
			path.join(root, 'scripts', 'generate-jsx-entities.mjs'),
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
