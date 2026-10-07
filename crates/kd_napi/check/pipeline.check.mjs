/**
 * Runs the whole pipeline through the built addon, with the JavaScript layer in front of
 * it: config → core (`prepare`) → worker threads that render the JSX pages → `feed` →
 * `finish` → files, and the dev server (`serveOpen`, `serveRequest`, ...) answering
 * requests. The unit tests of the Node package mock the addon and the ones of the core
 * have no renderer, so this is the one place where the two halves are shown to agree on
 * their JSON.
 *
 * Run: `cargo build --release -p kd_napi`, `yarn build`, then
 * `node --test crates/kd_napi/check/pipeline.check.mjs`. Not named `*.test.*` on purpose
 * so that vitest does not pick it up: it needs the native build.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const dist = path.resolve(
	import.meta.dirname,
	'..',
	'..',
	'..',
	'packages',
	'kamado-v3',
	'dist',
);
const { build } = await import(pathToFileURL(path.join(dist, 'build.js')).href);

/**
 * A small site: a TSX page that uses a layout, a TSX page without one, an HTML page, and a
 * script. `many` more pages (30 are enough to leave the inline path of the renderer).
 * @param {number} many how many more pages
 * @returns {string} the path of the config file
 */
function makeSite(many = 30) {
	const site = mkdtempSync(path.join(tmpdir(), 'kd-pipeline-'));
	mkdirSync(path.join(site, 'src', '_layouts'), { recursive: true });
	mkdirSync(path.join(site, 'src', 'many'), { recursive: true });
	writeFileSync(
		path.join(site, 'kamado.config.jsonc'),
		JSON.stringify({
			dir: { input: 'src', output: 'out' },
			build: { cacheDir: '.cache' },
			pages: { layouts: { dir: 'src/_layouts' }, ignore: ['_layouts/**', '_parts/**'] },
			html: { doctype: false, format: false, minify: false },
			// A port of the dynamic range, so that two runs side by side rarely meet.
			devServer: { host: '127.0.0.1', port: 49_152 + (process.pid % 16_000) },
		}),
	);
	writeFileSync(
		path.join(site, 'src', '_layouts', 'default.tsx'),
		'export default ({ content, meta }) => (\n' +
			'\t<html lang="en"><head><title>{meta.title}</title></head><body>{content}</body></html>\n' +
			');\n',
	);
	writeFileSync(
		path.join(site, 'src', 'index.tsx'),
		"export const meta = { title: 'Home', layout: 'default' };\n" +
			'export default ({ meta }) => <main><h1>{meta.title} &amp; more</h1></main>;\n',
	);
	writeFileSync(
		path.join(site, 'src', 'plain.tsx'),
		'export default ({ page }) => <p>{page.url}</p>;\n',
	);
	writeFileSync(
		path.join(site, 'src', 'static.html'),
		'---\ntitle: Static\nlayout: default\n---\n<p>a &amp; b</p>\n',
	);
	for (let i = 0; i < many; i++) {
		writeFileSync(
			path.join(site, 'src', 'many', `p${i}.tsx`),
			`export default () => <i>n${i}</i>;\n`,
		);
	}
	return path.join(site, 'kamado.config.jsonc');
}

const read = (config, file) =>
	readFileSync(path.join(path.dirname(config), 'out', file), 'utf8');

test('build renders TSX pages in workers, wraps them in the layout and writes the files', async () => {
	const config = makeSite();

	const report = await build(config, {});

	assert.equal(report.pages.length, 33);
	assert.ok(report.pages.every((p) => p.status === 'built'));
	assert.equal(
		read(config, 'index.html'),
		'<html lang="en"><head><title>Home</title></head><body><main><h1>Home &amp; more</h1></main></body></html>',
	);
	assert.equal(read(config, 'plain.html'), '<p>/plain.html</p>');
	// The body of an HTML page is the content of its layout: it is not escaped twice.
	assert.equal(
		read(config, 'static.html'),
		'<html lang="en"><head><title>Static</title></head><body><p>a &amp; b</p>\n</body></html>',
	);
	assert.equal(read(config, 'many/p29.html'), '<i>n29</i>');
});

test('a second incremental build finds everything unchanged and a changed page alone is built', async () => {
	const config = makeSite();
	await build(config, { incremental: true });

	const again = await build(config, { incremental: true });
	assert.ok(
		again.pages.every((p) => p.status === 'cached'),
		JSON.stringify(again.pages),
	);

	writeFileSync(
		path.join(path.dirname(config), 'src', 'plain.tsx'),
		'export default () => <p>changed</p>;\n',
	);
	const third = await build(config, { incremental: true });
	assert.deepEqual(
		third.pages.filter((p) => p.status === 'built').map((p) => p.url),
		['/plain.html'],
	);
	assert.equal(read(config, 'plain.html'), '<p>changed</p>');
});

test('the dev server renders a page on request, refuses to leave the output and answers 404', async () => {
	const config = makeSite();
	const { start } = await import(pathToFileURL(path.join(dist, 'index.js')).href);
	const server = await start(config, { write: () => {} });
	try {
		const base = new URL(server.location).origin;

		const home = await fetch(`${base}/`);
		assert.equal(home.status, 200);
		assert.equal(
			await home.text(),
			'<html lang="en"><head><title>Home</title></head><body><main><h1>Home &amp; more</h1></main></body></html>',
		);
		const missing = await fetch(`${base}/missing.html`);
		assert.equal(missing.status, 404);
		// `fetch` keeps `..` out of the path it sends; the encoded form is what a client could send.
		const outside = await fetch(`${base}/..%2f..%2f` + 'kamado.config.jsonc');
		assert.ok([403, 404].includes(outside.status), String(outside.status));
	} finally {
		await server.close();
	}
});

test('a second build in the same process renders a component edited since the first', async () => {
	const config = makeSite(0);
	const src = path.join(path.dirname(config), 'src');
	mkdirSync(path.join(src, '_parts'), { recursive: true });
	writeFileSync(
		path.join(src, '_parts', 'box.tsx'),
		'export const Box = () => <b>before</b>;\n',
	);
	writeFileSync(
		path.join(src, 'boxed.tsx'),
		"import { Box } from './_parts/box';\nexport default () => <p><Box /></p>;\n",
	);
	await build(config, { force: true });
	assert.equal(read(config, 'boxed.html'), '<p><b>before</b></p>');

	writeFileSync(
		path.join(src, '_parts', 'box.tsx'),
		'export const Box = () => <b>after</b>;\n',
	);
	await build(config, { force: true });

	assert.equal(read(config, 'boxed.html'), '<p><b>after</b></p>');
});

test('a page that throws fails the build with its path', async () => {
	const config = makeSite();
	writeFileSync(
		path.join(path.dirname(config), 'src', 'plain.tsx'),
		"export default () => { throw new Error('boom'); };\n",
	);

	await assert.rejects(build(config, {}), /plain\.tsx.*boom|boom.*plain\.tsx/s);
});
