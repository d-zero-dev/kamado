/**
 * A panic in the addon must reach JS as an `Error`, and the process must live on.
 *
 * It needs an addon built with the `panic-check` feature (it adds `panicCheck()`, which
 * panics). That build is a different one from the addon that is shipped, so it goes to
 * its own target directory:
 *
 *   cargo build --locked --offline --release -p kd_napi --features panic-check --target-dir target/panic-check
 *   node --test crates/kd_napi/check/panic.check.mjs
 *
 * Why it matters: `cargo test` always unwinds, so only a release build shows what a
 * panic does to the shipped addon (the profile `panic = "abort"` or a handler that is
 * `extern "C"` would end Node here, and the test run with it).
 */
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const ext = process.platform === 'darwin' ? 'dylib' : 'so';
const built = path.resolve(
	import.meta.dirname,
	'..',
	'..',
	'..',
	'target',
	'panic-check',
	'release',
	`libkd_napi.${ext}`,
);
// Node only loads files named `.node` through require().
const addonPath = path.join(
	mkdtempSync(path.join(tmpdir(), 'kd-napi-panic-')),
	'kd_napi.node',
);
copyFileSync(built, addonPath);
const addon = require(addonPath);

test('a panic is thrown as an Error that names the panic', () => {
	assert.throws(
		() => addon.panicCheck(),
		(error) => {
			assert.ok(error instanceof Error);
			assert.equal(
				error.message,
				'kamado: internal error (a panic in the native core): panic check',
			);
			return true;
		},
	);
});

test('the process and the other functions live on after a panic', () => {
	assert.throws(() => addon.panicCheck(), /panic check/);
	assert.match(addon.version(), /^kd_napi \d+\.\d+\.\d+/);
	assert.equal(typeof addon.counter(), 'number');
});

test('a panic can be thrown again and again', () => {
	for (let i = 0; i < 3; i++) {
		assert.throws(() => addon.panicCheck(), /panic check/);
	}
});
