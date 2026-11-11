/**
 * The editor of the pages through the built addon (`uiOpen`, `uiPages`, `uiValues`, `uiEdit`,
 * `uiRefresh`, `uiClose`): the unit tests of the core call the same engine without the addon, so this is
 * the place where the JSON that crosses it is shown to be what RFC §14.2 says, and where an
 * edit is shown to change the files on disk and nothing else.
 *
 * Run: `cargo build --release -p kd_napi`, `yarn build`, then
 * `node --test crates/kd_napi/check/ui.check.mjs`. Not named `*.test.*` on purpose so that
 * vitest does not pick it up: it needs the native build.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

test('sort orders every page, with the pages that have no value last either way', () => {
	const site = makeSite();
	const handle = native().uiOpen(site.config, '{}');
	const urls = (sort, extra = {}) =>
		JSON.parse(
			native().uiPages(handle, JSON.stringify({ offset: 0, limit: 100, sort, ...extra })),
		).pages.map((p) => p.url);
	try {
		assert.deepEqual(urls({ key: 'url' }), [
			'/',
			'/about/',
			'/about/history.html',
			'/ext/',
		]);
		assert.deepEqual(urls({ key: 'url', desc: true }), [
			'/ext/',
			'/about/history.html',
			'/about/',
			'/',
		]);
		// The virtual page has no input path: it is last, ascending or descending.
		assert.equal(urls({ key: 'inputPath' }).at(-1), '/ext/');
		assert.equal(urls({ key: 'inputPath', desc: true }).at(-1), '/ext/');
		// `virtual`: false before true, and true first when descending.
		assert.equal(urls({ key: 'virtual' }).at(-1), '/ext/');
		assert.equal(urls({ key: 'virtual', desc: true })[0], '/ext/');
		// Only `/about/` has `navHidden`; the others follow in the order of the plan.
		assert.deepEqual(urls({ key: 'meta:navHidden', desc: true }), [
			'/about/',
			'/ext/',
			'/about/history.html',
			'/',
		]);
		// A window is cut after the sort.
		assert.deepEqual(urls({ key: 'url' }, { offset: 1, limit: 2 }), [
			'/about/',
			'/about/history.html',
		]);
		assert.throws(
			() =>
				native().uiPages(
					handle,
					JSON.stringify({ offset: 0, limit: 1, sort: { key: 'title' } }),
				),
			/sort\.key/,
		);
	} finally {
		native().uiClose(handle);
	}
});

test('the values of a key are counted over every page, most often first', () => {
	const site = makeSite();
	const handle = native().uiOpen(site.config, '{}');
	const values = (key, limit = 100) =>
		JSON.parse(native().uiValues(handle, JSON.stringify({ key, limit })));
	try {
		// `layout` is in the sidecar of `/` only; `title` is held by three pages, once each.
		assert.deepEqual(values('meta:layout'), {
			version: 1,
			key: 'meta:layout',
			total: 1,
			values: [{ value: 'side', count: 1 }],
		});
		const title = values('meta:title');
		assert.equal(title.total, 3);
		assert.deepEqual(
			title.values.map((v) => v.value),
			['Ext', 'History', 'Top'],
		);
		// A boolean is a value of its own type; a key that no page has is no value.
		assert.deepEqual(values('meta:navHidden').values, [{ value: false, count: 1 }]);
		assert.deepEqual(values('meta:nothing').values, []);
		assert.equal(values('meta:title', 2).values.length, 2);
		assert.equal(values('meta:title', 2).total, 3);
		assert.throws(() => native().uiValues(handle, '{"key":"title","limit":1}'), /meta:/);
		assert.throws(() => native().uiValues(handle, '{"key":"meta:a"}'), /limit/);
		assert.throws(
			() => native().uiValues('999999', '{"key":"meta:a","limit":1}'),
			/no editor/,
		);
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

test('a moved path moves the files, removes the directory it empties, and layouts are listed', () => {
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
			pages: { layouts: { dir: 'layouts' } },
		}),
	);
	write('src/customer/send/index.html', '---\ntitle: Send\n---\n');
	write('layouts/sub.tsx', 'export default () => null;\n');
	write('layouts/sub-with-side.jsx', 'export default () => null;\n');
	write('layouts/readme.md', 'not a layout');
	const handle = native().uiOpen(path.join(root, 'kamado.config.jsonc'), '{}');
	try {
		let rows = JSON.parse(native().uiPages(handle, query));
		// the names of the files, without the extension, in the order of their bytes
		assert.deepEqual(rows.layouts, ['sub', 'sub-with-side']);
		const send = rows.pages.find((p) => p.url === '/customer/send/');
		const answer = JSON.parse(
			native().uiEdit(
				handle,
				JSON.stringify({
					url: '/customer/send/',
					expect: expectOf(rows, send),
					change: { op: 'movePath', path: 'customer/sending/' },
				}),
			),
		);
		assert.equal(answer.ok, true, JSON.stringify(answer));
		assert.equal(answer.page.url, '/customer/sending/');
		assert.equal(
			readFileSync(path.join(root, 'src/customer/sending/index.html'), 'utf8'),
			'---\ntitle: Send\n---\n',
		);
		// the directory it left is gone; the input directory is not
		assert.equal(existsSync(path.join(root, 'src/customer/send')), false);
		assert.equal(existsSync(path.join(root, 'src/customer')), true);

		// a layout that is added shows after the list is read again, and not before
		write('layouts/new-one.tsx', 'export default () => null;\n');
		rows = JSON.parse(native().uiPages(handle, query));
		assert.deepEqual(rows.layouts, ['sub', 'sub-with-side']);
		native().uiRefresh(handle);
		rows = JSON.parse(native().uiPages(handle, query));
		assert.deepEqual(rows.layouts, ['new-one', 'sub', 'sub-with-side']);

		// a path out of the input directory is refused, and nothing is written
		const here = rows.pages.find((p) => p.url === '/customer/sending/');
		const refused = JSON.parse(
			native().uiEdit(
				handle,
				JSON.stringify({
					url: '/customer/sending/',
					expect: expectOf(rows, here),
					change: { op: 'movePath', path: '../escaped.html' },
				}),
			),
		);
		assert.equal(refused.ok, false);
		assert.equal(refused.code, 'invalid');
		assert.equal(existsSync(path.join(root, 'escaped.html')), false);
	} finally {
		native().uiClose(handle);
	}
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

test('the editor tells the port and the directories of the config', () => {
	const site = makeSite();
	const handle = native().uiOpen(site.config, '{}');
	try {
		assert.deepEqual(JSON.parse(native().uiServer(handle)), {
			port: 3000,
			open: false,
			inputDir: path.join(site.root, 'src'),
			outputDir: path.join(site.root, 'out'),
		});
	} finally {
		native().uiClose(handle);
	}
	assert.throws(() => native().uiServer(handle), /no editor/);
});

test('the editor tells the devServer of the config and the directories as absolute paths', () => {
	const site = makeSite();
	writeFileSync(
		site.config,
		JSON.stringify({
			dir: { input: './src/', output: 'out/../out' },
			build: { cacheDir: '.cache' },
			devServer: { port: 4321, open: true },
		}),
	);
	const handle = native().uiOpen(site.config, '{}');
	try {
		const settings = JSON.parse(native().uiServer(handle));
		assert.equal(settings.port, 4321);
		assert.equal(settings.open, true);
		assert.ok(path.isAbsolute(settings.inputDir), settings.inputDir);
		assert.ok(path.isAbsolute(settings.outputDir), settings.outputDir);
		assert.equal(path.resolve(settings.inputDir), path.join(site.root, 'src'));
		assert.equal(path.resolve(settings.outputDir), path.join(site.root, 'out'));
	} finally {
		native().uiClose(handle);
	}
});

test('the server of kamado ui answers with what the core says, told without the directories of the machine', async () => {
	const { createUiApp } = await import(
		pathToFileURL(path.join(dist, 'ui', 'app.js')).href
	);
	const site = makeSite();
	const handle = native().uiOpen(site.config, '{}');
	const settings = JSON.parse(native().uiServer(handle));
	const token = 'a-token-for-the-check';
	const app = createUiApp(
		{
			handle,
			uiPages: (h, q) => native().uiPages(h, q),
			uiValues: (h, q) => native().uiValues(h, q),
			uiRefresh: (h) => native().uiRefresh(h),
			uiEdit: (h, e) => native().uiEdit(h, e),
		},
		{
			uiDir: path.join(site.root, 'no-screen'),
			token,
			roots: {
				rootDir: site.root,
				inputDir: settings.inputDir,
				outputDir: settings.outputDir,
			},
		},
	);
	const get = (url) => app.request(`http://localhost${url}`);
	const post = (url, body, headers = {}) =>
		app.request(`http://localhost${url}`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Kamado-Token': token,
				...headers,
			},
			body: JSON.stringify(body),
		});
	try {
		const listed = await get('/api/pages?limit=100');
		const text = await listed.text();
		assert.equal(listed.status, 200);
		assert.ok(!text.includes(site.root), 'an absolute path went to the screen');
		const rows = JSON.parse(text);
		// The fields the screen reads (client/src/types.ts) are the fields of the answer.
		assert.deepEqual(Object.keys(rows).toSorted(), [
			'columns',
			'layouts',
			'overridesHash',
			'pages',
			'total',
			'version',
			'warnings',
		]);
		const about = rows.pages.find((p) => p.url === '/about/history.html');
		assert.deepEqual(Object.keys(about).toSorted(), [
			'depth',
			'hashes',
			'inputPath',
			'meta',
			'outputPath',
			'parent',
			'url',
			'virtual',
		]);
		assert.equal(about.inputPath, 'about/history.html');
		assert.equal(about.outputPath, 'about/history.html');
		assert.deepEqual(Object.keys(about.meta.title).toSorted(), [
			'editable',
			'origin',
			'value',
		]);
		const virtual = rows.pages.find((p) => p.virtual);
		assert.equal(virtual.inputPath, null);

		// The values of a key: the fields the screen reads (client/src/types.ts), and nothing of the machine.
		const valued = await get('/api/values?key=meta:title&limit=10');
		const valuedText = await valued.text();
		assert.equal(valued.status, 200);
		assert.ok(!valuedText.includes(site.root), 'an absolute path went to the screen');
		const values = JSON.parse(valuedText);
		assert.deepEqual(Object.keys(values).toSorted(), [
			'key',
			'total',
			'values',
			'version',
		]);
		assert.equal(values.key, 'meta:title');
		assert.deepEqual(Object.keys(values.values[0]).toSorted(), ['count', 'value']);
		assert.deepEqual(
			values.values.map((v) => v.value),
			['Ext', 'History', 'Top'],
		);
		const refused = await get('/api/values?key=title');
		assert.equal(refused.status, 400);

		const expect = {
			input: about.hashes.input,
			sidecar: about.hashes.sidecar,
			overrides: rows.overridesHash,
		};
		const edited = await post('/api/edit', {
			url: about.url,
			expect,
			change: { op: 'set', key: 'title', value: 'Changed' },
		});
		assert.equal(edited.status, 200, await edited.clone().text());
		assert.match(site.read('src/about/history.html'), /title: Changed/);

		// The same hashes again: the file is not the one they were taken from.
		const stale = await post('/api/edit', {
			url: about.url,
			expect,
			change: { op: 'set', key: 'title', value: 'Again' },
		});
		const conflict = await stale.text();
		assert.equal(stale.status, 409);
		assert.ok(!conflict.includes(site.root));
		const body = JSON.parse(conflict);
		assert.equal(body.error, 'conflict');
		assert.equal(body.current.inputPath, 'about/history.html');
		assert.match(site.read('src/about/history.html'), /title: Changed/);

		const taken = await post('/api/edit', {
			url: about.url,
			expect: { ...expect, input: body.current.hashes.input },
			change: { op: 'moveUrl', url: '/' },
		});
		assert.equal(taken.status, 409);
		const collision = await taken.json();
		assert.equal(collision.error, 'collision');

		const noToken = await app.request('http://localhost/api/edit', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{}',
		});
		assert.equal(noToken.status, 403);
	} finally {
		native().uiClose(handle);
	}
});

test('the dev server finds a page the editor moved, and no longer finds it at its old URL', () => {
	const site = makeSite();
	const editor = native().uiOpen(site.config, '{}');
	const server = JSON.parse(
		native().serveOpen(
			site.config,
			JSON.stringify({ serving: true, tzOffsetMinutes: 0 }),
			'file:///runtime.js',
		),
	).handle;
	const ask = (url) => JSON.parse(native().serveRequest(server, url, '1')).kind;
	const move = (from, to) => {
		const rows = JSON.parse(native().uiPages(editor, query));
		const row = rows.pages.find((p) => p.url === from);
		return JSON.parse(
			native().uiEdit(
				editor,
				JSON.stringify({
					url: from,
					expect: expectOf(rows, row),
					change: { op: 'moveUrl', url: to },
				}),
			),
		);
	};
	try {
		assert.equal(ask('/about/history.html'), 'text');

		// asked for at the old URL first
		assert.equal(move('/about/history.html', '/company/history.html').ok, true);
		assert.equal(ask('/about/history.html'), 'notFound');
		assert.equal(ask('/company/history.html'), 'text');

		// asked for at the new URL first (a request for a URL that is no page plans nothing)
		assert.equal(move('/company/history.html', '/news/history.html').ok, true);
		assert.equal(ask('/favicon.ico'), 'notFound');
		assert.equal(ask('/news/history.html'), 'text');
		assert.equal(ask('/company/history.html'), 'notFound');
	} finally {
		native().serveClose(server);
		native().uiClose(editor);
	}
});

test('the path the screen shows for a page is the path it can send back to move the file', async () => {
	const { createUiApp } = await import(
		pathToFileURL(path.join(dist, 'ui', 'app.js')).href
	);
	const site = makeSite();
	const handle = native().uiOpen(site.config, '{}');
	const settings = JSON.parse(native().uiServer(handle));
	const token = 'a-token-for-the-check';
	const app = createUiApp(
		{
			handle,
			uiPages: (h, q) => native().uiPages(h, q),
			uiValues: (h, q) => native().uiValues(h, q),
			uiRefresh: (h) => native().uiRefresh(h),
			uiEdit: (h, e) => native().uiEdit(h, e),
		},
		{
			uiDir: path.join(site.root, 'no-screen'),
			token,
			roots: {
				rootDir: site.root,
				inputDir: settings.inputDir,
				outputDir: settings.outputDir,
			},
		},
	);
	try {
		const listed = await app.request('http://localhost/api/pages?limit=100');
		const rows = await listed.json();
		const history = rows.pages.find((p) => p.url === '/about/history.html');
		// what the screen shows is relative to the input directory
		assert.equal(history.inputPath, 'about/history.html');
		const moved = await app.request('http://localhost/api/edit', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-Kamado-Token': token },
			body: JSON.stringify({
				url: history.url,
				expect: {
					input: history.hashes.input,
					sidecar: history.hashes.sidecar,
					overrides: rows.overridesHash,
				},
				// the text of the cell with its file name changed, as it is typed
				change: {
					op: 'movePath',
					path: history.inputPath.replace('history', 'chronicle'),
				},
			}),
		});
		const body = await moved.json();
		assert.equal(moved.status, 200, JSON.stringify(body));
		// it is the file beside the old one, and not one below the input directory again
		assert.equal(body.page.url, '/about/chronicle.html');
		assert.equal(body.page.inputPath, 'about/chronicle.html');
		assert.equal(site.read('src/about/chronicle.html'), '---\ntitle: History\n---\n');
		assert.equal(existsSync(path.join(site.root, 'src/about/history.html')), false);
	} finally {
		native().uiClose(handle);
	}
});
