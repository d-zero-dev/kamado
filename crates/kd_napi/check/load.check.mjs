/**
 * Loads the built addon from the main thread and from workers, and runs a
 * build through it.
 *
 * Run: `cargo build --release -p kd_napi` then `node --test crates/kd_napi/check/load.check.mjs`.
 * Not named `*.test.*` on purpose so that vitest (`yarn test`) does not pick it up:
 * it needs the native build, which the TypeScript test run does not produce.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';

const require = createRequire(import.meta.url);
const ext = process.platform === 'darwin' ? 'dylib' : 'so';
const built = path.resolve(
	import.meta.dirname,
	'..',
	'..',
	'..',
	'target',
	'release',
	`libkd_napi.${ext}`,
);
// Node only loads files named `.node` through require().
const dir = mkdtempSync(path.join(tmpdir(), 'kd-napi-'));
const addonPath = path.join(dir, 'kd_napi.node');
copyFileSync(built, addonPath);
const addon = require(addonPath);

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

test('version', () => {
	assert.match(addon.version(), /^kd_napi \d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
});

test('sha256Hex matches node:crypto (empty, small, 8 MiB)', () => {
	for (const buf of [
		Buffer.alloc(0),
		Buffer.from('abc'),
		Buffer.alloc(8 * 1024 * 1024, 0x61),
	]) {
		assert.equal(addon.sha256Hex(buf), sha(buf));
	}
});

test('sha256Hex throws on non-Buffer or missing arguments', () => {
	assert.throws(() => addon.sha256Hex('abc'), /must be a Buffer/);
	assert.throws(() => addon.sha256Hex(), /expected one Buffer/);
});

test('process-wide state is shared between the main thread and workers', async () => {
	const before = addon.counter();
	const workerSource = `
		const { parentPort } = require('node:worker_threads');
		const addon = require(${JSON.stringify(addonPath)});
		parentPort.postMessage(addon.counter());
	`;
	const seen = await Promise.all(
		[1, 2, 3, 4].map(
			() =>
				new Promise((resolve, reject) => {
					const w = new Worker(workerSource, { eval: true });
					w.once('message', resolve);
					w.once('error', reject);
				}),
		),
	);
	const after = addon.counter();
	// Every worker call incremented the same counter: 4 distinct values strictly
	// between the two main-thread reads.
	assert.equal(new Set(seen).size, 4);
	for (const n of seen) {
		assert.ok(n > before && n < after, `${n} not in (${before}, ${after})`);
	}
});

test('build writes HTML pages and returns a report', () => {
	const site = mkdtempSync(path.join(tmpdir(), 'kd-site-'));
	mkdirSync(path.join(site, 'src', 'about'), { recursive: true });
	writeFileSync(
		path.join(site, 'kamado.config.jsonc'),
		'{ "dir": { "input": "src", "output": "out" }, "build": { "cacheDir": ".cache" } }',
	);
	writeFileSync(
		path.join(site, 'src', 'index.html'),
		'---\ntitle: Home\n---\n<h1>Home</h1>\n',
	);
	writeFileSync(path.join(site, 'src', 'about', 'index.html'), '<p>about</p>');

	const report = JSON.parse(
		addon.build(path.join(site, 'kamado.config.jsonc'), JSON.stringify({ jobs: 2 })),
	);
	assert.equal(report.version, 1);
	assert.deepEqual(
		report.pages.map((p) => [p.url, p.status]),
		[
			['/about/', 'built'],
			['/', 'built'],
		],
	);
	assert.deepEqual(report.pages[1].meta, { title: 'Home' });
	assert.equal(
		readFileSync(path.join(site, 'out', 'index.html'), 'utf8'),
		'<h1>Home</h1>\n',
	);
	assert.equal(
		readFileSync(path.join(site, 'out', 'about', 'index.html'), 'utf8'),
		'<p>about</p>\n',
	);
});

test('build throws a JS Error for config problems', () => {
	assert.throws(
		() => addon.build('/nonexistent/kamado.config.jsonc', '{}'),
		/cannot read config/,
	);
	assert.throws(() => addon.build(), /expected a config path string/);
	const site = mkdtempSync(path.join(tmpdir(), 'kd-site-'));
	writeFileSync(path.join(site, 'kamado.config.jsonc'), '{ "compilers": [] }');
	assert.throws(
		() => addon.build(path.join(site, 'kamado.config.jsonc'), '{}'),
		/compilers: unknown option/,
	);
	assert.throws(
		() => addon.build(path.join(site, 'kamado.config.jsonc'), '{ "jobs": 0 }'),
		/jobs must be a positive integer/,
	);
});
