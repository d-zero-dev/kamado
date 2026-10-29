import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
	knownProperties,
	readColorNames,
	readSources,
	renderColorTable,
	renderPropertyTable,
} from './generate-css-tables.mjs';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'crates', 'kd_css', 'src');

describe('generate-css-tables', () => {
	test('mdn-data is the version package.json declares', () => {
		const declared = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
			.devDependencies['mdn-data'];
		expect(readSources().mdnData.version).toBe(declared);
	});

	test('color_table.rs is what the generator writes for the installed colordx', () => {
		const committed = readFileSync(path.join(src, 'color_table.rs'), 'utf8');
		// If this fails after @colordx/core was upgraded: node scripts/generate-css-tables.mjs
		expect(renderColorTable(readColorNames(readSources().colorNames))).toBe(committed);
	});

	test('property_table.rs is what the generator writes for the installed mdn-data', () => {
		const { mdnData } = readSources();
		const committed = readFileSync(path.join(src, 'property_table.rs'), 'utf8');
		// If this fails after mdn-data was upgraded: node scripts/generate-css-tables.mjs
		expect(
			renderPropertyTable(knownProperties(mdnData.properties), mdnData.version),
		).toBe(committed);
	});

	test('the properties lose their vendor prefix, once each', () => {
		const names = knownProperties({ '-webkit-zz': {}, '-moz-zz': {} });
		expect(names.filter((p) => p.endsWith('zz'))).toEqual(['zz']);
	});

	test('the properties are sorted', () => {
		const names = knownProperties({ 'zz-b': {}, 'zz-a': {} });
		expect(names.filter((p) => p.startsWith('zz-'))).toEqual(['zz-a', 'zz-b']);
	});

	test('a property mdn-data no longer lists stays known', () => {
		expect(knownProperties({})).toEqual(
			expect.arrayContaining(['azimuth', 'image-region', 'input-security']),
		);
	});

	test('the table says which mdn-data it was made from', () => {
		expect(renderPropertyTable(['a'], '9.9.9').split('\n')[1]).toBe(
			"//! Source: the properties of mdn-data 9.9.9 and the generator's `extras`.",
		);
	});
});
