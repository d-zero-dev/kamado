/**
 * The base of a relative cache directory (RFC §13): the program API resolves it against the
 * directory of the config file, the command line's `--cache-dir` against the directory the
 * command was typed in. The two are checked through the built CLI and `pages()`, because the
 * resolution is split between `cli.ts` (cwd) and the core (config directory), so neither side
 * alone shows that the same relative path reaches two places.
 *
 * Run: `cargo build --release -p kd_napi`, `yarn build`, then
 * `node --test crates/kd_napi/check/cache-dir.check.mjs`. Not named `*.test.*` on purpose so
 * that vitest does not pick it up: it needs the native build.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

const dist = path.resolve(
	import.meta.dirname,
	'..',
	'..',
	'..',
	'packages',
	'kamado',
	'dist',
);
for (const file of ['build.js', 'cli.js', 'pages.js']) {
	if (!existsSync(path.join(dist, file))) {
		throw new Error(`${path.join(dist, file)} is not built: run yarn build first`);
	}
}
const { build } = await import(pathToFileURL(path.join(dist, 'build.js')).href);
const { pages } = await import(pathToFileURL(path.join(dist, 'pages.js')).href);

const PLAN_CACHE = 'plan-cache.bin';
const MANIFEST = 'build-manifest.bin';
const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'kd-cache-dir-')));
after(() => rmSync(root, { recursive: true, force: true }));

/**
 * Writes a site into its own directory of the temporary one.
 * @param {string} name - The directory name of the site
 * @returns {string} The path of the config file of the site
 */
function makeSite(name) {
	const site = path.join(root, name, 'site');
	mkdirSync(path.join(site, 'src'), { recursive: true });
	writeFileSync(path.join(site, 'package.json'), '{}');
	writeFileSync(path.join(site, 'src', 'index.html'), '<p>x</p>\n');
	const config = path.join(site, 'kamado.config.jsonc');
	writeFileSync(config, '{ "dir": { "input": "src", "output": "htdocs" } }\n');
	return config;
}

test('--cache-dir of the command line is relative to the directory it was typed in', () => {
	const config = makeSite('cli');
	const cwd = path.join(root, 'cli');
	execFileSync(
		process.execPath,
		[
			path.join(dist, 'cli.js'),
			'pages',
			'--incremental',
			'--cache-dir',
			'cache-x',
			'--config',
			config,
			'--out',
			path.join(cwd, 'pages.json'),
		],
		{ cwd, env: { ...process.env, NO_COLOR: '1' } },
	);
	assert.ok(existsSync(path.join(cwd, 'cache-x', PLAN_CACHE)));
	assert.ok(!existsSync(path.join(cwd, 'site', 'cache-x')));
});

test('cacheDir of the API is relative to the directory of the config file', async () => {
	const config = makeSite('api');
	const cwd = path.join(root, 'api');
	await pages(config, { incremental: true, cacheDir: 'cache-x' });
	assert.ok(existsSync(path.join(cwd, 'site', 'cache-x', PLAN_CACHE)));
	assert.ok(!existsSync(path.join(cwd, 'cache-x')));
	assert.ok(!existsSync(path.join(process.cwd(), 'cache-x')));
});

test('--cache-dir of kamado build is relative to the directory it was typed in', () => {
	const config = makeSite('cli-build');
	const cwd = path.join(root, 'cli-build');
	execFileSync(
		process.execPath,
		[
			path.join(dist, 'cli.js'),
			'build',
			'--incremental',
			'--cache-dir',
			'cache-x',
			'--config',
			config,
		],
		{ cwd, env: { ...process.env, NO_COLOR: '1' } },
	);
	assert.ok(existsSync(path.join(cwd, 'cache-x', MANIFEST)));
	assert.ok(!existsSync(path.join(cwd, 'site', 'cache-x')));
});

test('cacheDir of build() is relative to the directory of the config file', async () => {
	const config = makeSite('api-build');
	const cwd = path.join(root, 'api-build');
	await build(config, { incremental: true, cacheDir: 'cache-x' });
	assert.ok(existsSync(path.join(cwd, 'site', 'cache-x', MANIFEST)));
	assert.ok(!existsSync(path.join(cwd, 'cache-x')));
	assert.ok(!existsSync(path.join(process.cwd(), 'cache-x')));
});

test('an absolute cache directory is the same for both', async () => {
	const config = makeSite('absolute');
	const cwd = path.join(root, 'absolute');
	const cache = path.join(root, 'absolute-cache');
	await build(config, { incremental: true, cacheDir: cache });
	assert.ok(existsSync(path.join(cache, MANIFEST)));
	assert.ok(!existsSync(path.join(cwd, 'site', path.basename(cache))));
});
