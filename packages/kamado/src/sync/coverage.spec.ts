/**
 * What a sync has to follow when the editor or the list of pages changes (RFC §14.2, "同期とページの
 * 編集の連動"): the tables of `diff.ts` say which edits and which fields a sync uses, and these tests
 * compare them with what the core really accepts and writes. A change in the core only (an edit
 * that is added, a field that is added to the list) fails here until the sync says what it does
 * with it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { EDIT_OPS, ENTRY_FIELDS } from './diff.js';

/**
 * A source file of the core.
 * @param relative - The path from the root of the repository
 */
function source(relative: string): string {
	return readFileSync(
		fileURLToPath(new URL(`../../../../${relative}`, import.meta.url)),
		'utf8',
	);
}

describe('the edits the core accepts', () => {
	// `parse_edit` has one arm for each: `Some(Value::String(op)) if op == "<name>"`.
	const text = source('crates/kd_core/src/ui.rs');
	const start = text.indexOf('fn parse_edit(');
	const end = text.indexOf('impl Ui {', start);
	const accepted = [
		...new Set(
			[
				...text
					.slice(start, end)
					.matchAll(/Some\(Value::String\(op\)\) if op == "(\w+)"/g),
			].map((match) => match[1]!),
		),
	].toSorted();

	test('are found in the source of the core', () => {
		expect(accepted.length).toBeGreaterThanOrEqual(9);
	});

	test('are each said by the sync to be used, or not used with a reason', () => {
		expect(
			Object.keys(EDIT_OPS).toSorted(),
			'the core accepts an edit that diff.ts EDIT_OPS does not say anything about (or the reverse): decide what a sync does with it, then say it in EDIT_OPS (CLAUDE.md, "連動して変える箇所")',
		).toEqual(accepted);
	});

	test('are used, except a revert, which a script cannot return', () => {
		const unused = Object.entries(EDIT_OPS)
			.filter(([, how]) => how !== 'used')
			.map(([op]) => op);
		expect(unused).toEqual(['revert']);
		for (const [, how] of Object.entries(EDIT_OPS)) {
			expect(how === 'used' || how.startsWith('unused: ')).toBe(true);
		}
	});
});

describe('the fields of a page of the list', () => {
	const text = source('crates/kd_core/src/page_map.rs');
	const start = text.indexOf('fn entry_json(');
	const end = text.indexOf('#[cfg(test)]', start);
	const written = [...text.slice(start, end).matchAll(/\(\s*"(\w+)"\.to_owned\(\)/g)]
		.map((match) => match[1]!)
		.toSorted();

	test('are found in the source of the core', () => {
		expect(written).toContain('url');
		expect(written).toContain('meta');
	});

	test('are each said by the sync to be read, or ignored with a reason', () => {
		expect(
			Object.keys(ENTRY_FIELDS).toSorted(),
			'the list of kamado pages has a field that diff.ts ENTRY_FIELDS does not say anything about (or the reverse): decide whether a sync reads it, then say it in ENTRY_FIELDS (CLAUDE.md, "連動して変える箇所")',
		).toEqual(written);
		for (const how of Object.values(ENTRY_FIELDS)) {
			expect(how === 'read' || how.startsWith('ignored: ')).toBe(true);
		}
	});

	test('are read exactly as a script is told to return them', () => {
		expect(
			Object.entries(ENTRY_FIELDS)
				.filter(([, how]) => how === 'read')
				.map(([field]) => field)
				.toSorted(),
		).toEqual(['inputPath', 'meta', 'url', 'virtual']);
	});
});

describe('the answer of the core for a sync', () => {
	test('has every field of the list and adds the hashes; the locked keys are asked for apart', () => {
		const text = source('crates/kd_core/src/ui.rs');
		const start = text.indexOf('pub fn sync_pages(');
		const end = text.indexOf('pub fn sync_locked(', start);
		expect(end).toBeGreaterThan(start);
		const body = text.slice(start, end);
		expect(body).toContain('crate::page_map::entry_json');
		expect(body).toContain('"hashes"');
		// telling which keys are locked parses every page file, so the list must not do it
		expect(body).not.toContain('page_json(');
		expect(text.slice(end, end + 3000)).toContain('"locked"');
	});
});
