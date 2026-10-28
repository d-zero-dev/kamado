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
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
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
	'kamado',
	'dist',
);
const { build } = await import(pathToFileURL(path.join(dist, 'build.js')).href);

/**
 * A small site: a TSX page that uses a layout, a TSX page without one, an HTML page, and a
 * script. `many` more pages (30 are enough to leave the inline path of the renderer).
 * @param {number} many how many more pages
 * @param {string} host `devServer.host`
 * @returns {string} the path of the config file
 */
function makeSite(many = 30, host = '127.0.0.1') {
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
			devServer: { host, port: 49_152 + (process.pid % 16_000) },
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

/**
 * Sends an HTTP/1.0 request without `Host` and reads the status code.
 * @param {number} port the port
 * @param {string} address the address to connect to
 * @returns {Promise<number>} the status code
 */
function getWithoutHost(port, address = '127.0.0.1') {
	return new Promise((resolve, reject) => {
		let head = '';
		const socket = net.connect(port, address, () => {
			socket.write('GET / HTTP/1.0\r\n\r\n');
		});
		socket.setEncoding('utf8');
		socket.on('data', (chunk) => (head += chunk));
		socket.on('end', () => resolve(Number(head.split(' ')[1])));
		socket.on('error', reject);
	});
}

/**
 * Whether the machine has `address` (`::1` is missing where IPv6 is off).
 * @param {string} address an IP address
 * @returns {Promise<boolean>} whether it can be listened on
 */
function has(address) {
	const server = net.createServer();
	return new Promise((resolve) => {
		server.once('error', () => resolve(false));
		server.listen(0, address, () => server.close(() => resolve(true)));
	});
}

test('the dev server on localhost answers on both loopback addresses and without Host', async () => {
	const config = makeSite(0, 'localhost');
	const { start } = await import(pathToFileURL(path.join(dist, 'index.js')).href);
	const server = await start(config, { write: () => {} });
	try {
		const { port } = new URL(server.location);
		assert.equal(server.location, `http://localhost:${port}/`);
		const v4 = await fetch(`http://127.0.0.1:${port}/`);
		assert.equal(v4.status, 200);
		if (await has('::1')) {
			const v6 = await fetch(`http://[::1]:${port}/`);
			assert.equal(v6.status, 200);
		}
		// Taken to be sent to `devServer.host`, which the host check lets through.
		assert.equal(await getWithoutHost(Number(port)), 200);
	} finally {
		await server.close();
	}
});

test('the dev server on ::1 takes a request without Host to be sent to [::1]', async (t) => {
	if (!(await has('::1'))) {
		t.diagnostic('this machine has no ::1');
		return;
	}
	const config = makeSite(0, '::1');
	const { start } = await import(pathToFileURL(path.join(dist, 'index.js')).href);
	const server = await start(config, { write: () => {} });
	try {
		const { port } = new URL(server.location);
		assert.equal(await getWithoutHost(Number(port), '::1'), 200);
	} finally {
		await server.close();
	}
});

test('the dev server on localhost does not start when 127.0.0.1 holds the port', async () => {
	const config = makeSite(0, 'localhost');
	const { port } = JSON.parse(readFileSync(config, 'utf8')).devServer;
	const holder = net.createServer();
	await new Promise((resolve) => holder.listen(port, '127.0.0.1', resolve));
	try {
		const { start } = await import(pathToFileURL(path.join(dist, 'index.js')).href);
		await assert.rejects(
			start(config, { write: () => {} }),
			new RegExp(
				`^Error: port ${port} is already in use on 127\\.0\\.0\\.1 \\(devServer\\.port\\)$`,
			),
		);
	} finally {
		await new Promise((resolve) => holder.close(resolve));
	}
});

/**
 * An upstream that starts an event stream and never ends it, and a site that
 * proxies `/events` to it.
 * @returns {Promise<{ upstream: http.Server, config: string, port: number }>} the
 * upstream, the config file and `devServer.port`
 */
async function streamingSite() {
	const upstream = http.createServer((_, res) => {
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		res.write('data: open\n\n');
	});
	await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
	const config = makeSite(0, 'localhost');
	const settings = JSON.parse(readFileSync(config, 'utf8'));
	settings.devServer.proxy = { '/events': `http://127.0.0.1:${upstream.address().port}` };
	writeFileSync(config, JSON.stringify(settings));
	return { upstream, config, port: settings.devServer.port };
}

/**
 * Opens `/events/` and resolves when the upstream has the request.
 * @param {http.Server} upstream the upstream of {@link streamingSite}
 * @param {number} port `devServer.port`
 */
async function openStream(upstream, port) {
	const streaming = new Promise((resolve) => upstream.once('request', resolve));
	http.get({ host: '127.0.0.1', port, path: '/events/' }).on('error', () => {});
	await streaming;
}

/**
 * Resolves with what `promise` resolves with, or `'still running'` after 5 s.
 * @param {Promise<unknown>} promise what to wait on
 * @returns {Promise<unknown>} the result
 */
async function within5s(promise) {
	let timer;
	const result = await Promise.race([
		promise,
		new Promise((resolve) => {
			timer = setTimeout(() => resolve('still running'), 5000);
		}),
	]);
	clearTimeout(timer);
	return result;
}

test('close() stops the dev server while a proxied response is still streaming', async () => {
	const { upstream, config, port } = await streamingSite();
	const { start } = await import(pathToFileURL(path.join(dist, 'index.js')).href);
	const server = await start(config, { write: () => {} });
	try {
		await openStream(upstream, port);
		assert.equal(await within5s(server.close().then(() => 'closed')), 'closed');
	} finally {
		upstream.closeAllConnections();
		await new Promise((resolve) => upstream.close(resolve));
	}
});

test('Ctrl+C stops the dev server while a proxied response is still streaming', async () => {
	const { upstream, config, port } = await streamingSite();
	const child = spawn(
		process.execPath,
		[path.join(dist, 'cli.js'), 'server', '--config', config],
		{
			stdio: ['ignore', 'pipe', 'inherit'],
		},
	);
	const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
	try {
		await new Promise((resolve, reject) => {
			let out = '';
			child.stdout.on('data', (chunk) => {
				out += chunk;
				if (out.includes('Location')) {
					resolve();
				}
			});
			child.once('exit', (code) => reject(new Error(`the server exited with ${code}`)));
		});
		await openStream(upstream, port);

		child.kill('SIGINT');
		assert.equal(await within5s(exited), 0);
	} finally {
		// Waited on, so that the next test finds the port free.
		child.kill('SIGKILL');
		await exited;
		upstream.closeAllConnections();
		await new Promise((resolve) => upstream.close(resolve));
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
