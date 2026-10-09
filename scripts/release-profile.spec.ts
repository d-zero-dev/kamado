import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const manifest = readFileSync(
	path.resolve(import.meta.dirname, '..', 'Cargo.toml'),
	'utf8',
);
const release = manifest.split('[profile.release]')[1] ?? '';

// `cargo test` always unwinds, so the profile of the release build, which the addon is
// shipped with, is checked here: with `abort`, a panic in the native core ends the Node
// process instead of becoming a JS `Error` (`kd_napi::guard`).
describe('the release profile of the workspace', () => {
	test('unwinds on a panic, so that the addon can turn it into a JS Error', () => {
		expect(release).toMatch(/^panic = "unwind"$/m);
	});

	test('does not abort on a panic', () => {
		expect(release).not.toMatch(/^panic = "abort"$/m);
	});
});
