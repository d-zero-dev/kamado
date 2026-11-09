/**
 * The editor of the pages through the built addon (`uiOpen`, `uiPages`, `uiEdit`, `uiRefresh`,
 * `uiClose`): the unit tests of the core call the same engine without the addon, so this is
 * the place where the JSON that crosses it is shown to be what RFC §14.2 says, and where an
 * edit is shown to change the files on disk and nothing else.
 *
 * Run: `cargo build --release -p kd_napi`, `yarn build`, then
 * `node --test crates/kd_napi/check/ui.check.mjs`. Not named `*.test.*` on purpose so that
 * vitest does not pick it up: it needs the native build.
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
	'kamado',
	'dist',
);
const { native } = await import(pathToFileURL(path.join(dist, 'native.js')).href);

/**
 * A small site: an HTML page with front matter and a sidecar, a TSX page, a page of a
 * directory, and a `pages.overrides` file that orders them and declares a virtual page.
 * @returns {{ root: string, config: string, read: (rel: string) => string }} the site
 */
function makeSite() {
	const root = mkdtempSync(path.join(tmpdir(), 'kd-ui-'));
	const write = (rel, text) => {
		mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		writeFileSync(path.join(root, rel), text);
	};
	write(
		'kamado.config.jsonc',
		JSON.stringify({
			dir: { input: 'src', output: 'out' },
			build: { cacheDir: '.cache' },
			pages: { overrides: 'pages.overrides.json' },
		}),
	);
	write('src/index.html', '---\n# top\ntitle: Top\n---\n<p>top</p>\n');
	write('src/index.json', '{\n\t// the side\n\t"layout": "side"\n}\n');
	write('src/about/index.tsx', 'export default () => null;\n');
	write('src/about/history.html', '---\ntitle: History\n---\n');
	write(
		'pages.overrides.json',
		'{\n\t"version": 1,\n\t"pages": [\n\t\t{ "url": "/about/", "meta": { "navHidden": false } },\n\t\t{ "url": "/ext/", "virtual": true, "meta": { "title": "Ext" } }\n\t]\n}\n',
	);
	return {
		root,
		config: path.join(root, 'kamado.config.jsonc'),
		read: (rel) => readFileSync(path.join(root, rel), 'utf8'),
	};
}

/**
 * The `expect` an edit of `row` sends: the hashes of the files the row shows.
 * @param {any} rows what `uiPages` returned
 * @param {any} row one of its pages
 * @returns {object} the hashes
 */
function expectOf(rows, row) {
	return {
		input: row.hashes.input,
		sidecar: row.hashes.sidecar,
		overrides: rows.overridesHash,
	};
}

const query = JSON.stringify({ offset: 0, limit: 100 });

test('the rows say where each value comes from, in the order of the plan', () => {
	const site = makeSite();
	const handle = native().uiOpen(site.config, '{}');
	try {
		const rows = JSON.parse(native().uiPages(handle, query));
		assert.equal(rows.total, 4);
		assert.deepEqual(
			rows.pages.map((p) => p.url),
			['/about/', '/ext/', '/about/history.html', '/'],
		);
		assert.deepEqual(rows.columns, ['layout', 'navHidden', 'title']);
		const top = rows.pages.find((p) => p.url === '/');
		assert.equal(top.meta.title.origin, 'inFile');
		assert.equal(top.meta.layout.origin, 'sidecar');
		assert.equal(top.hashes.sidecar.length, 64);
		const about = rows.pages.find((p) => p.url === '/about/');
		assert.equal(about.meta.navHidden.origin, 'overrides');
		const ext = rows.pages.find((p) => p.url === '/ext/');
		assert.equal(ext.virtual, true);
		assert.equal(ext.inputPath, null);
		assert.equal(rows.overridesHash.length, 64);
		assert.equal(rows.pages.find((p) => p.url === '/about/history.html').depth, 2);
	} finally {
		native().uiClose(handle);
	}
});

test('an edit changes the file the value comes from and no other byte', () => {
	const site = makeSite();
	const handle = native().uiOpen(site.config, '{}');
	try {
		let rows = JSON.parse(native().uiPages(handle, query));
		const top = rows.pages.find((p) => p.url === '/');
		const answer = JSON.parse(
			native().uiEdit(
				handle,
				JSON.stringify({
					url: '/',
					expect: expectOf(rows, top),
					change: { op: 'set', key: 'title', value: 'Home' },
				}),
			),
		);
		assert.equal(answer.ok, true, JSON.stringify(answer));
		assert.equal(answer.page.meta.title.value, 'Home');
		assert.equal(
			site.read('src/index.html'),
			'---\n# top\ntitle: Home\n---\n<p>top</p>\n',
		);
		assert.equal(
			site.read('src/index.json'),
			'{\n\t// the side\n\t"layout": "side"\n}\n',
		);

		rows = JSON.parse(native().uiPages(handle, query));
		const ext = rows.pages.find((p) => p.url === '/ext/');
		const added = JSON.parse(
			native().uiEdit(
				handle,
				JSON.stringify({
					url: '/ext/',
					expect: expectOf(rows, ext),
					change: { op: 'set', key: 'navHidden', value: true },
				}),
			),
		);
		assert.equal(added.ok, true, JSON.stringify(added));
		assert.notEqual(added.overridesHash, rows.overridesHash);
		assert.match(
			site.read('pages.overrides.json'),
			/\{ "url": "\/ext\/", "virtual": true, "meta": \{ "title": "Ext", "navHidden": true \} \}/,
		);
		assert.ok(site.read('pages.overrides.json').startsWith('{\n\t"version": 1,'));
	} finally {
		native().uiClose(handle);
	}
});

test('a file that changed since it was read is not overwritten', () => {
	const site = makeSite();
	const handle = native().uiOpen(site.config, '{}');
	try {
		const rows = JSON.parse(native().uiPages(handle, query));
		const top = rows.pages.find((p) => p.url === '/');
		const expect = expectOf(rows, top);
		writeFileSync(
			path.join(site.root, 'src/index.html'),
			'---\n# top\ntitle: Tap\n---\n<p>top</p>\n',
		);
		const answer = JSON.parse(
			native().uiEdit(
				handle,
				JSON.stringify({
					url: '/',
					expect,
					change: { op: 'set', key: 'title', value: 'Home' },
				}),
			),
		);
		assert.equal(answer.ok, false);
		assert.equal(answer.code, 'conflict');
		assert.equal(
			site.read('src/index.html'),
			'---\n# top\ntitle: Tap\n---\n<p>top</p>\n',
		);
		assert.throws(() => native().uiEdit(handle, '{'), /invalid JSON/);
		assert.throws(() => native().uiPages('999999', query), /no editor/);
	} finally {
		native().uiClose(handle);
	}
});

test('a moved URL moves the files, and refreshing reads what changed outside', () => {
	const site = makeSite();
	const handle = native().uiOpen(site.config, '{}');
	try {
		const rows = JSON.parse(native().uiPages(handle, query));
		const history = rows.pages.find((p) => p.url === '/about/history.html');
		const answer = JSON.parse(
			native().uiEdit(
				handle,
				JSON.stringify({
					url: '/about/history.html',
					expect: expectOf(rows, history),
					change: { op: 'moveUrl', url: '/company/history.html' },
				}),
			),
		);
		assert.equal(answer.ok, true, JSON.stringify(answer));
		assert.equal(answer.page.url, '/company/history.html');
		assert.equal(site.read('src/company/history.html'), '---\ntitle: History\n---\n');
		const after = JSON.parse(native().uiPages(handle, query));
		assert.equal(
			after.pages.some((p) => p.url === '/about/history.html'),
			false,
		);

		writeFileSync(path.join(site.root, 'src/extra.html'), '');
		const { version } = JSON.parse(native().uiRefresh(handle));
		assert.ok(version > after.version);
		assert.equal(JSON.parse(native().uiPages(handle, query)).total, 5);
		const found = JSON.parse(
			native().uiPages(handle, JSON.stringify({ offset: 0, limit: 10, q: 'extra' })),
		);
		assert.equal(found.total, 1);
	} finally {
		assert.deepEqual(JSON.parse(native().uiClose(handle)), { warning: null });
	}
	// a handle that is closed is closed
	assert.throws(() => native().uiClose(handle), /no editor/);
	assert.throws(() => native().uiPages(handle, query), /no editor/);
});

test('a module, a sidecar, a deleted key and a key that makes the URL', () => {
	const root = mkdtempSync(path.join(tmpdir(), 'kd-ui-'));
	const write = (rel, text) => {
		mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		writeFileSync(path.join(root, rel), text);
	};
	write(
		'kamado.config.jsonc',
		JSON.stringify({
			dir: { input: 'src', output: 'out' },
			build: { cacheDir: '.cache' },
			pages: { outputPathField: 'path' },
		}),
	);
	write(
		'src/p/page.tsx',
		"import { x } from '../shared/x';\nexport const meta = { title: 'T', n: 1 };\nexport default () => x;\n",
	);
	write('src/p/page.json', '{ "layout": "side" }');
	write('src/1.html', '---\npath: /en/data.json\n---\n');
	const config = path.join(root, 'kamado.config.jsonc');
	const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
	const handle = native().uiOpen(config, '{}');
	const send = (url, rows, row, change) =>
		JSON.parse(
			native().uiEdit(
				handle,
				JSON.stringify({
					url,
					expect: {
						input: row.hashes.input,
						sidecar: row.hashes.sidecar,
						overrides: null,
					},
					change,
				}),
			),
		);
	try {
		let rows = JSON.parse(native().uiPages(handle, query));
		const find = (url) => rows.pages.find((p) => p.url === url);
		assert.deepEqual(rows.columns, ['layout', 'n', 'title']);
		assert.equal(find('/p/page.html').meta.layout.origin, 'sidecar');

		// the module and the sidecar are edited, each in its own file
		let answer = send('/p/page.html', rows, find('/p/page.html'), {
			op: 'set',
			key: 'title',
			value: "it's",
		});
		assert.equal(answer.ok, true, JSON.stringify(answer));
		assert.match(read('src/p/page.tsx'), /title: 'it\\'s', n: 1/);
		rows = JSON.parse(native().uiPages(handle, query));
		answer = send('/p/page.html', rows, find('/p/page.html'), {
			op: 'set',
			key: 'layout',
			value: 'main',
		});
		assert.equal(answer.ok, true, JSON.stringify(answer));
		assert.equal(read('src/p/page.json'), '{ "layout": "main" }');
		rows = JSON.parse(native().uiPages(handle, query));
		answer = send('/p/page.html', rows, find('/p/page.html'), { op: 'delete', key: 'n' });
		assert.equal(answer.ok, true, JSON.stringify(answer));
		assert.match(read('src/p/page.tsx'), /meta = \{ title: 'it\\'s' \}/);

		// the key that makes the URL is a URL, and a page moves with the imports it has
		rows = JSON.parse(native().uiPages(handle, query));
		answer = send('/en/data.json', rows, find('/en/data.json'), {
			op: 'set',
			key: 'path',
			value: '/x.html',
		});
		assert.equal(answer.ok, false);
		assert.equal(answer.code, 'notEditable');
		answer = send('/en/data.json', rows, find('/en/data.json'), {
			op: 'moveUrl',
			url: '/en/other.json',
		});
		assert.equal(answer.ok, true, JSON.stringify(answer));
		assert.equal(read('src/1.html'), '---\npath: /en/other.json\n---\n');
		rows = JSON.parse(native().uiPages(handle, query));
		answer = send('/p/page.html', rows, find('/p/page.html'), {
			op: 'moveUrl',
			url: '/a/b/page.html',
		});
		assert.equal(answer.ok, true, JSON.stringify(answer));
		assert.match(read('src/a/b/page.tsx'), /from '\.\.\/\.\.\/shared\/x'/);
		assert.equal(read('src/a/b/page.json'), '{ "layout": "main" }');
	} finally {
		native().uiClose(handle);
	}
});

test('a call that is not one throws', () => {
	const site = makeSite();
	assert.throws(
		() => native().uiOpen(path.join(site.root, 'missing.jsonc'), '{}'),
		/cannot read config/,
	);
	assert.throws(() => native().uiOpen(site.config, '{'), /./);
	const handle = native().uiOpen(site.config, '{}');
	try {
		assert.throws(() => native().uiPages(handle, '{"offset":-1,"limit":1}'), /offset/);
		assert.throws(() => native().uiPages(handle, '{"limit":1}'), /offset/);
		assert.throws(
			() => native().uiEdit(handle, '{"url":"/","change":{"op":"explode"}}'),
			/change\.op/,
		);
		assert.throws(() => native().uiPages('not a handle', query), /not a handle/);
	} finally {
		native().uiClose(handle);
	}
});
