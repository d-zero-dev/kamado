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
import { execFileSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
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
 * directory, and a `pages.overrides` file that overrides meta and declares a virtual page.
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
		// Behavior change: the order of `pages` is the one `order` and the URLs make (RFC section 6): a page before what hangs from it, the children in the natural order of their URLs; `columns` always has `order` (RFC section 14.2): the key that places a page is a column even when no page has it
		assert.deepEqual(
			rows.pages.map((p) => p.url),
			['/', '/about/', '/about/history.html', '/ext/'],
		);
		assert.deepEqual(rows.columns, ['layout', 'navHidden', 'order', 'title']);
		// assert.deepEqual(
		// 	rows.pages.map((p) => p.url),
		// 	['/about/', '/ext/', '/about/history.html', '/'],
		// );
		// assert.deepEqual(rows.columns, ['layout', 'navHidden', 'title']); // previous
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
		// Behavior change: the order of `pages` is the one `order` and the URLs make (RFC section 6): a page before what hangs from it, the children in the natural order of their URLs
		assert.deepEqual(urls({ key: 'meta:navHidden', desc: true }), [
			'/about/',
			'/',
			'/about/history.html',
			'/ext/',
		]);
		// assert.deepEqual(urls({ key: 'meta:navHidden', desc: true }), [
		// 	'/about/',
		// 	'/ext/',
		// 	'/about/history.html',
		// 	'/',
		// ]); // previous
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
			// Behavior change: the order of `pages` is the one `order` and the URLs make (RFC section 6): a page before what hangs from it, the children in the natural order of their URLs
			title.values.map((v) => v.value),
			['Top', 'History', 'Ext'],
			// title.values.map((v) => v.value),
			// ['Ext', 'History', 'Top'], // previous
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
		// Behavior change: `columns` always has `order` (RFC section 14.2): the key that places a page is a column even when no page has it
		assert.deepEqual(rows.columns, ['layout', 'n', 'order', 'title']);
		// assert.deepEqual(rows.columns, ['layout', 'n', 'title']); // previous
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
		// Behavior change: uiServer also tells syncFunctions (none here)
		assert.deepEqual(JSON.parse(native().uiServer(handle)), {
			port: 3000,
			open: false,
			inputDir: path.join(site.root, 'src'),
			outputDir: path.join(site.root, 'out'),
			overrides: path.join(site.root, 'pages.overrides.json'),
			syncFunctions: [],
		});
		// assert.deepEqual(JSON.parse(native().uiServer(handle)), { // previous
		// 	port: 3000, // previous
		// 	open: false, // previous
		// 	inputDir: path.join(site.root, 'src'), // previous
		// 	outputDir: path.join(site.root, 'out'), // previous
		// 	overrides: path.join(site.root, 'pages.overrides.json'), // previous
		// }); // previous
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
		// Behavior change: the answer carries how the config presents the keys (`keys`)
		// Behavior change: the answer carries where its window starts (`offset`)
		assert.deepEqual(Object.keys(rows).toSorted(), [
			'columns',
			'keys',
			'layouts',
			'offset',
			'overridesFile',
			'overridesHash',
			'pages',
			'total',
			'version',
			'warnings',
		]);
		// assert.deepEqual(Object.keys(rows).toSorted(), [ // previous
		// 	'columns', // previous
		// 	'keys', // previous
		// 	'layouts', // previous
		// 	'overridesFile', // previous
		// 	'overridesHash', // previous
		// 	'pages', // previous
		// 	'total', // previous
		// 	'version', // previous
		// 	'warnings', // previous
		// ]); // previous
		// assert.deepEqual(Object.keys(rows).toSorted(), [ // previous
		// 	'columns', // previous
		// 	'layouts', // previous
		// 	'overridesFile', // previous
		// 	'overridesHash', // previous
		// 	'pages', // previous
		// 	'total', // previous
		// 	'version', // previous
		// 	'warnings', // previous
		// ]); // previous
		const about = rows.pages.find((p) => p.url === '/about/history.html');
		// Behavior change: a row says its place in the plan (`order`)
		// Behavior change: a row carries no number of its place in the plan (RFC section 14.2): `order` is a key of the metadata
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
		// assert.deepEqual(Object.keys(about).toSorted(), [ // previous
		// 	'depth', // previous
		// 	'hashes', // previous
		// 	'inputPath', // previous
		// 	'meta', // previous
		// 	'order', // previous
		// 	'outputPath', // previous
		// 	'parent', // previous
		// 	'url', // previous
		// 	'virtual', // previous
		// ]); // previous
		// assert.deepEqual(Object.keys(about).toSorted(), [ // previous
		// 	'depth', // previous
		// 	'hashes', // previous
		// 	'inputPath', // previous
		// 	'meta', // previous
		// 	'outputPath', // previous
		// 	'parent', // previous
		// 	'url', // previous
		// 	'virtual', // previous
		// ]); // previous
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
		// Behavior change: the order of `pages` is the one `order` and the URLs make (RFC section 6): a page before what hangs from it, the children in the natural order of their URLs
		assert.deepEqual(
			values.values.map((v) => v.value),
			['Top', 'History', 'Ext'],
		);
		// assert.deepEqual( // previous
		// 	values.values.map((v) => v.value), // previous
		// 	['Ext', 'History', 'Top'], // previous
		// ); // previous
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

test('a page is made, made virtual, given a file again and removed, and only its files change', async () => {
	const site = makeSite();
	const handle = native().uiOpen(site.config, '{}');
	const edit = (request) => JSON.parse(native().uiEdit(handle, JSON.stringify(request)));
	const others = () => [
		site.read('src/index.html'),
		site.read('src/index.json'),
		site.read('src/about/index.tsx'),
		site.read('src/about/history.html'),
	];
	const before = others();
	try {
		// a page file where the path says; the place gives the URL, and the row its place in the plan
		const made = edit({
			url: null,
			expect: {},
			change: { op: 'create', path: 'news/index.html' },
		});
		assert.equal(made.ok, true, JSON.stringify(made));
		assert.equal(made.page.url, '/news/');
		assert.equal(made.page.virtual, false);
		assert.equal(site.read('src/news/index.html'), '');
		// the page is at the place its `order` and its url give it, which no row says
		// Behavior change: a row carries no number of its place in the plan (RFC section 14.2): `order` is a key of the metadata
		assert.equal(made.page.order, undefined);
		// assert.equal(made.page.order, 5); // previous

		// a virtual page: an entry after the last one of `pages.overrides`
		const virtual = edit({
			url: '/service/',
			expect: { overrides: made.overridesHash },
			change: { op: 'create', path: null },
		});
		assert.equal(virtual.ok, true, JSON.stringify(virtual));
		assert.equal(virtual.page.virtual, true);
		assert.equal(virtual.page.inputPath, null);
		assert.match(
			site.read('pages.overrides.json'),
			/\{ "url": "\/ext\/", "virtual": true, "meta": \{ "title": "Ext" \} \},\n\t\t\{"url":"\/service\/","virtual":true\}\n\t\]/,
		);

		// a key of the new page, then the page made virtual: the key goes to `pages.overrides` with it
		let rows = JSON.parse(native().uiPages(handle, query));
		let news = rows.pages.find((p) => p.url === '/news/');
		const titled = edit({
			url: '/news/',
			expect: expectOf(rows, news),
			change: { op: 'set', key: 'title', value: 'News' },
		});
		assert.equal(titled.ok, true, JSON.stringify(titled));
		rows = JSON.parse(native().uiPages(handle, query));
		news = rows.pages.find((p) => p.url === '/news/');
		const gone = edit({
			url: '/news/',
			expect: expectOf(rows, news),
			change: { op: 'virtualize' },
		});
		assert.equal(gone.ok, true, JSON.stringify(gone));
		assert.equal(gone.page.virtual, true);
		assert.equal(gone.page.meta.title.value, 'News');
		assert.equal(gone.page.meta.title.origin, 'overrides');
		assert.equal(existsSync(path.join(site.root, 'src/news')), false);
		assert.ok(
			site
				.read('pages.overrides.json')
				.includes('{"url":"/news/","virtual":true,"meta":{"title":"News"}}'),
		);

		// given a file again, where its URL says: the key goes back into the file, the entry goes
		const back = edit({
			url: '/news/',
			expect: { overrides: gone.overridesHash },
			change: { op: 'materialize', path: null },
		});
		assert.equal(back.ok, true, JSON.stringify(back));
		assert.equal(back.page.virtual, false);
		assert.equal(back.page.meta.title.origin, 'inFile');
		assert.equal(site.read('src/news/index.html'), '---\ntitle: News\n---\n');
		assert.equal(site.read('pages.overrides.json').includes('/news/'), false);

		// removed: the answer has no page, and the list one row less
		rows = JSON.parse(native().uiPages(handle, query));
		news = rows.pages.find((p) => p.url === '/news/');
		const removed = edit({
			url: '/news/',
			expect: expectOf(rows, news),
			change: { op: 'deletePage' },
		});
		assert.deepEqual(Object.keys(removed).toSorted(), [
			'ok',
			'overridesHash',
			'page',
			'version',
		]);
		assert.equal(removed.ok, true);
		assert.equal(removed.page, null);
		assert.equal(existsSync(path.join(site.root, 'src/news')), false);
		const service = edit({
			url: '/service/',
			expect: { overrides: removed.overridesHash },
			change: { op: 'deletePage' },
		});
		assert.equal(service.ok, true, JSON.stringify(service));
		const after = JSON.parse(native().uiPages(handle, query));
		// Behavior change: the order of `pages` is the one `order` and the URLs make (RFC section 6): a page before what hangs from it, the children in the natural order of their URLs
		assert.deepEqual(
			after.pages.map((p) => p.url),
			['/', '/about/', '/about/history.html', '/ext/'],
		);
		// assert.deepEqual( // previous
		// 	after.pages.map((p) => p.url), // previous
		// 	['/about/', '/ext/', '/about/history.html', '/'], // previous
		// ); // previous
		// the file is what it was before the pages came and went, to the byte
		assert.equal(
			site.read('pages.overrides.json'),
			'{\n\t"version": 1,\n\t"pages": [\n\t\t{ "url": "/about/", "meta": { "navHidden": false } },\n\t\t{ "url": "/ext/", "virtual": true, "meta": { "title": "Ext" } }\n\t]\n}\n',
		);
		assert.deepEqual(others(), before);

		// The columns every row has are sorts: the rows come in the order of each, both ways.
		// (The plan is /, /about/, /about/history.html, /ext/.)
		const sortedBy = (key, desc) =>
			JSON.parse(
				native().uiPages(
					handle,
					JSON.stringify({ offset: 0, limit: 100, sort: { key, desc } }),
				),
			).pages.map((p) => p.url);
		const orders = {
			// the files below the output directory: index.html, about/index.html, about/history.html, ext/index.html
			outputPath: ['/', '/about/', '/about/history.html', '/ext/'],
			// the page above: / for /about/ and /ext/, /about/ for the history; / has none and is last
			parent: ['/about/', '/ext/', '/about/history.html', '/'],
			// 0 for /, 1 for /about/ and /ext/ (in the order of the plan), 2 for the history
			depth: ['/', '/about/', '/ext/', '/about/history.html'],
		};
		const reversed = {
			outputPath: ['/ext/', '/about/history.html', '/about/', '/'],
			// the page without a value is last this way too
			parent: ['/about/history.html', '/about/', '/ext/', '/'],
			depth: ['/about/history.html', '/about/', '/ext/', '/'],
		};
		for (const key of Object.keys(orders)) {
			assert.deepEqual(sortedBy(key, false), orders[key], key);
			assert.deepEqual(sortedBy(key, true), reversed[key], `${key} desc`);
		}
		// Every column the server takes as a sort is one the core takes: a column added to one
		// and not to the other is found here.
		const { BUILTIN_COLUMNS } = await import(
			pathToFileURL(path.join(dist, 'ui', 'settings.js')).href
		);
		assert.deepEqual(
			[...BUILTIN_COLUMNS].toSorted(),
			['url', 'virtual', 'inputPath', ...Object.keys(orders)].toSorted(),
		);
		for (const key of BUILTIN_COLUMNS) {
			assert.equal(sortedBy(key, false).length, 4, key);
		}
		assert.throws(() => sortedBy('hashes', false), /sort\.key/);
	} finally {
		native().uiClose(handle);
	}
});

test('the screen makes and removes pages by the paths it shows, and a build finds what it left', async () => {
	const { createUiApp } = await import(
		pathToFileURL(path.join(dist, 'ui', 'app.js')).href
	);
	const site = makeSite();
	// The sidecar of the top page names a layout the site of these checks does not have, which
	// only a build minds. It is taken away before the editor opens, so that the site the editor
	// leaves is the site that is built, with nothing changed in between.
	rmSync(path.join(site.root, 'src/index.json'));
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
	const post = async (body) => {
		const response = await app.request('http://localhost/api/edit', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-Kamado-Token': token },
			body: JSON.stringify(body),
		});
		const text = await response.text();
		assert.ok(!text.includes(site.root), `an absolute path went to the screen: ${text}`);
		return { status: response.status, body: JSON.parse(text) };
	};
	try {
		// a module, by the path as it is typed: relative to the input directory
		const made = await post({
			url: null,
			expect: {},
			change: { op: 'create', path: 'team/index.tsx' },
		});
		assert.equal(made.status, 200, JSON.stringify(made.body));
		assert.equal(made.body.page.url, '/team/');
		assert.equal(made.body.page.inputPath, 'team/index.tsx');
		assert.equal(made.body.page.outputPath, 'team/index.html');
		assert.equal(
			site.read('src/team/index.tsx'),
			'export default function Page() {\n\treturn null;\n}\n',
		);

		// what is in the way is said without the directories of the machine
		const again = await post({
			url: null,
			expect: {},
			change: { op: 'create', path: 'team/index.tsx' },
		});
		assert.equal(again.status, 409);
		assert.equal(again.body.error, 'collision');
		assert.ok(again.body.message.includes('<input>/team/index.tsx'), again.body.message);

		// the page file goes, and the URL stays as a virtual page
		const listed = await app.request('http://localhost/api/pages?limit=100');
		const rows = await listed.json();
		const history = rows.pages.find((p) => p.url === '/about/history.html');
		const virtual = await post({
			url: history.url,
			expect: {
				input: history.hashes.input,
				sidecar: history.hashes.sidecar,
				overrides: rows.overridesHash,
			},
			change: { op: 'virtualize' },
		});
		assert.equal(virtual.status, 200, JSON.stringify(virtual.body));
		assert.equal(virtual.body.page.inputPath, null);
		assert.equal(virtual.body.page.meta.title.value, 'History');
		assert.equal(existsSync(path.join(site.root, 'src/about/history.html')), false);

		// a page that is removed is answered as no page
		const removed = await post({
			url: '/ext/',
			expect: { overrides: virtual.body.overridesHash },
			change: { op: 'deletePage' },
		});
		assert.equal(removed.status, 200, JSON.stringify(removed.body));
		assert.equal(removed.body.page, null);
	} finally {
		native().uiClose(handle);
	}
	// What the editor left is a site that builds: the module that was made is a page, the
	// page made virtual is in the report and not in the output, the page removed is nowhere.
	const { build } = await import(pathToFileURL(path.join(dist, 'build.js')).href);
	const report = await build(site.config, {});
	const status = Object.fromEntries(report.pages.map((p) => [p.url, p.status]));
	assert.equal(status['/team/'], 'built', JSON.stringify(report.pages));
	assert.equal(status['/about/history.html'], 'virtual');
	assert.equal('/ext/' in status, false);
	assert.equal(existsSync(path.join(site.root, 'out/team/index.html')), true);
	assert.equal(existsSync(path.join(site.root, 'out/about/history.html')), false);
});

test('the difference from HEAD reaches the screen as RFC §14.2 says, and a revert writes only the files it has to', async () => {
	const { createUiApp } = await import(
		pathToFileURL(path.join(dist, 'ui', 'app.js')).href
	);
	const { createHeadDiff } = await import(
		pathToFileURL(path.join(dist, 'ui', 'head-diff.js')).href
	);
	const site = makeSite();
	const git = (...args) =>
		execFileSync(
			'git',
			['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
			{
				cwd: site.root,
				encoding: 'utf8',
				// What the machine's own configuration says is not part of the check.
				env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
			},
		).trim();
	git('init', '-q', '-b', 'main');
	writeFileSync(path.join(site.root, '.gitignore'), '.cache\nout\n');
	git('add', '.');
	git('commit', '-q', '-m', 'first');
	const commit = git('rev-parse', 'HEAD');
	// What changes after the commit: a value, a new key, and a page that is not in it.
	writeFileSync(
		path.join(site.root, 'src/about/history.html'),
		'---\ntitle: Edited\nextra: 1\n---\n',
	);
	writeFileSync(path.join(site.root, 'src/new.html'), '---\ntitle: New\n---\n');

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
			head: createHeadDiff({ cwd: site.root, core: native(), handle }),
			overridesFile: 'pages.overrides.json',
			roots: {
				rootDir: site.root,
				inputDir: settings.inputDir,
				outputDir: settings.outputDir,
			},
		},
	);
	const post = (url, body) =>
		app.request(`http://localhost${url}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-Kamado-Token': token },
			body: JSON.stringify(body),
		});
	try {
		const listedAnswer = await app.request('http://localhost/api/pages?limit=100');
		const listed = await listedAnswer.json();
		assert.equal(listed.overridesFile, 'pages.overrides.json');
		const urls = listed.pages.map((p) => p.url);

		const answer = await post('/api/diff', { urls });
		const text = await answer.text();
		assert.equal(answer.status, 200);
		assert.ok(!text.includes(site.root), 'an absolute path went to the screen');
		const diffs = JSON.parse(text);
		// The fields the screen reads (client/src/types.ts).
		assert.deepEqual(Object.keys(diffs).toSorted(), [
			'columns',
			'head',
			'pages',
			'version',
		]);
		assert.deepEqual(diffs.head, { oid: commit });
		const history = diffs.pages['/about/history.html'];
		assert.deepEqual(history.meta.title, {
			kind: 'modified',
			head: 'History',
			revertible: true,
			writes: ['inFile'],
		});
		assert.deepEqual(history.meta.extra, {
			kind: 'added',
			revertible: true,
			writes: ['inFile'],
		});
		// A page that HEAD does not have, and whose differences cannot be put back.
		const added = diffs.pages['/new.html'];
		assert.equal(added.url.kind, 'added');
		assert.equal(added.url.revertible, false);
		assert.equal(added.inputPath.kind, 'added');
		assert.equal(diffs.pages['/'], undefined);

		const refused = await post('/api/diff', { urls: [] });
		assert.equal(refused.status, 400);

		const row = listed.pages.find((p) => p.url === '/about/history.html');
		const expect = {
			input: row.hashes.input,
			sidecar: row.hashes.sidecar,
			overrides: listed.overridesHash,
		};
		// A commit other than the one the screen compared with writes nothing.
		const moved = await post('/api/revert', {
			url: row.url,
			expect,
			key: 'title',
			head: 'a'.repeat(40),
		});
		assert.equal(moved.status, 409);
		const movedBody = await moved.json();
		assert.equal(movedBody.error, 'headMoved');
		assert.match(site.read('src/about/history.html'), /title: Edited/);

		const reverted = await post('/api/revert', {
			url: row.url,
			expect,
			key: 'title',
			head: commit,
		});
		assert.equal(reverted.status, 200, await reverted.clone().text());
		assert.equal(
			site.read('src/about/history.html'),
			'---\ntitle: History\nextra: 1\n---\n',
		);

		// A revert is not an edit that a request can describe: what HEAD held is read from git.
		const forged = await post('/api/edit', {
			url: row.url,
			expect,
			change: { op: 'revert', key: 'title', head: {} },
		});
		assert.equal(forged.status, 400);

		// What it was does not differ from HEAD any more.
		const afterAnswer = await post('/api/diff', { urls: ['/about/history.html'] });
		const after = await afterAnswer.json();
		assert.equal(after.pages['/about/history.html'].meta.title, undefined);
		assert.equal(after.pages['/about/history.html'].meta.extra.kind, 'added');
	} finally {
		native().uiClose(handle);
	}
});

test('ui.keys of the config reaches the screen as it is written, and adds no column', async () => {
	const { createUiApp } = await import(
		pathToFileURL(path.join(dist, 'ui', 'app.js')).href
	);
	const site = makeSite();
	const keys = {
		title: {
			label: { ja: 'タイトル', en: 'Title' },
			description: 'Written for /home/u/site/src and "quoted"\nin two lines',
		},
		nothing: { label: 'No page has this key' },
	};
	writeFileSync(
		site.config,
		JSON.stringify({
			dir: { input: 'src', output: 'out' },
			build: { cacheDir: '.cache' },
			pages: { overrides: 'pages.overrides.json' },
			ui: { keys },
		}),
	);
	const handle = native().uiOpen(site.config, '{}');
	try {
		const settings = JSON.parse(native().uiServer(handle));
		const app = createUiApp(
			{
				handle,
				uiPages: (h, q) => native().uiPages(h, q),
				uiRefresh: (h) => native().uiRefresh(h),
				uiEdit: (h, e) => native().uiEdit(h, e),
			},
			{
				uiDir: path.join(site.root, 'no-screen'),
				token: 'a-token-for-the-check',
				roots: {
					rootDir: site.root,
					inputDir: settings.inputDir,
					outputDir: settings.outputDir,
				},
			},
		);
		const response = await app.request('http://localhost/api/pages?limit=100');
		const rows = await response.json();
		// the texts are the config's: they are not told without the directories (those are
		// the ones kamado finds, and the author wrote this one)
		assert.deepEqual(rows.keys, keys);
		// the keys of the config are not columns: the columns are the keys the pages hold
		assert.ok(!rows.columns.includes('nothing'));
		// Behavior change: `columns` always has `order` (RFC section 14.2): the key that places a page is a column even when no page has it
		assert.deepEqual(rows.columns, ['layout', 'navHidden', 'order', 'title']);
		// assert.deepEqual(rows.columns, ['layout', 'navHidden', 'title']); // previous
	} finally {
		native().uiClose(handle);
		rmSync(site.root, { recursive: true, force: true });
	}
});

test('a batch of edits is made as one: an exchange of URLs is made, and a refused batch writes nothing', () => {
	const site = makeSite();
	writeFileSync(path.join(site.root, 'src/other.html'), '---\ntitle: Other\n---\n');
	const handle = native().uiOpen(site.config, '{}');
	try {
		const rows = JSON.parse(native().uiPages(handle, query));
		const history = rows.pages.find((p) => p.url === '/about/history.html');
		const other = rows.pages.find((p) => p.url === '/other.html');
		const before = {
			history: site.read('src/about/history.html'),
			other: site.read('src/other.html'),
			overrides: site.read('pages.overrides.json'),
		};
		const batch = (edits) =>
			JSON.parse(native().uiEditBatch(handle, JSON.stringify({ edits })));

		// refused after the first edit was made: the second moves into a URL that stays a page
		const refused = batch([
			{
				url: '/about/history.html',
				expect: expectOf(rows, history),
				change: { op: 'set', key: 'title', value: 'Changed' },
			},
			{
				url: '/other.html',
				expect: expectOf(rows, other),
				change: { op: 'moveUrl', url: '/' },
			},
		]);
		assert.equal(refused.ok, false, JSON.stringify(refused));
		assert.equal(refused.errors.length, 1);
		assert.equal(refused.errors[0].index, 1);
		assert.equal(site.read('src/about/history.html'), before.history);
		assert.equal(site.read('src/other.html'), before.other);
		assert.equal(site.read('pages.overrides.json'), before.overrides);

		// the two pages exchange their URLs, and a key of one is set in the same batch
		const swapped = batch([
			{
				url: '/about/history.html',
				expect: expectOf(rows, history),
				change: { op: 'moveUrl', url: '/other.html' },
			},
			{
				url: '/other.html',
				expect: expectOf(rows, other),
				change: { op: 'moveUrl', url: '/about/history.html' },
			},
			{
				url: '/other.html',
				expect: expectOf(rows, other),
				change: { op: 'set', key: 'title', value: 'Other 2' },
			},
		]);
		assert.equal(swapped.ok, true, JSON.stringify(swapped));
		assert.equal(swapped.count, 3);
		assert.equal(site.read('src/other.html'), before.history);
		assert.equal(site.read('src/about/history.html'), '---\ntitle: Other 2\n---\n');
		assert.equal(
			JSON.parse(native().uiPages(handle, query)).pages.filter((p) =>
				p.url.endsWith('history.html'),
			).length,
			1,
		);
	} finally {
		native().uiClose(handle);
		rmSync(site.root, { recursive: true, force: true });
	}
});

test('a batch tells every edit that cannot be made, refuses a request that is not one, and changes the entries of pages.overrides in one write', () => {
	const site = makeSite();
	const handle = native().uiOpen(site.config, '{}');
	try {
		const rows = JSON.parse(native().uiPages(handle, query));
		const history = rows.pages.find((p) => p.url === '/about/history.html');
		const batch = (edits) =>
			JSON.parse(native().uiEditBatch(handle, JSON.stringify({ edits })));
		const overrides = () => site.read('pages.overrides.json');
		const before = {
			history: site.read('src/about/history.html'),
			overrides: overrides(),
			version: rows.version,
		};

		// an empty batch changes nothing and tells nothing
		const empty = batch([]);
		assert.deepEqual(
			{ ok: empty.ok, count: empty.count, version: empty.version },
			{ ok: true, count: 0, version: before.version },
		);
		assert.equal(empty.warning, undefined);

		// every edit that cannot be made is told, with its place in the request, before a byte is written
		const refused = batch([
			{ url: '/nowhere/', expect: {}, change: { op: 'deletePage' } },
			{
				url: '/about/history.html',
				expect: expectOf(rows, history),
				change: { op: 'revert', key: 'title', head: {} },
			},
			{
				url: '/about/history.html',
				expect: expectOf(rows, history),
				change: { op: 'moveUrl', url: '/about/history.html' },
			},
		]);
		assert.equal(refused.ok, false);
		assert.deepEqual(
			refused.errors.map((e) => [e.index, e.code]),
			[
				[0, 'notFound'],
				[1, 'invalid'],
				[2, 'invalid'],
			],
		);
		assert.equal(site.read('src/about/history.html'), before.history);
		assert.equal(overrides(), before.overrides);
		assert.equal(JSON.parse(native().uiPages(handle, query)).version, before.version);

		// a stale hash is a conflict and writes nothing
		const stale = batch([
			{
				url: '/about/history.html',
				expect: { ...expectOf(rows, history), input: '0'.repeat(64) },
				change: { op: 'set', key: 'title', value: 'Late' },
			},
		]);
		assert.equal(stale.code, 'conflict');
		assert.equal(site.read('src/about/history.html'), before.history);

		// entries of pages.overrides: a virtual page made and one moved
		const ex = { overrides: rows.overridesHash };
		// (the refusal for a stale hash read the site again, so the version moved on)
		const versionBefore = JSON.parse(native().uiPages(handle, query)).version;
		const made = batch([
			{ url: '/new/', expect: ex, change: { op: 'create', path: null } },
			{ url: '/ext/', expect: ex, change: { op: 'moveUrl', url: '/external/' } },
		]);
		assert.equal(made.ok, true, JSON.stringify(made));
		assert.equal(made.count, 2);
		assert.equal(made.version, versionBefore + 1);
		const after = overrides();
		assert.match(after, /"\/new\/"/);
		assert.match(after, /"\/external\/"/);
		assert.doesNotMatch(after, /"\/ext\/"/);
		const now = JSON.parse(native().uiPages(handle, query));
		assert.equal(
			now.pages.some((p) => p.url === '/new/' && p.virtual),
			true,
		);
		assert.equal(
			now.pages.some((p) => p.url === '/external/'),
			true,
		);
		assert.equal(now.overridesHash, made.overridesHash);

		// a request that is not one throws
		assert.throws(() => native().uiEditBatch(handle, '{'), /invalid JSON/);
		assert.throws(() => native().uiEditBatch(handle, '{"edits":{}}'), /edits/);
		assert.throws(
			() =>
				native().uiEditBatch(handle, '{"edits":[{"url":"/","change":{"op":"explode"}}]}'),
			/change\.op/,
		);
	} finally {
		native().uiClose(handle);
		rmSync(site.root, { recursive: true, force: true });
	}
	assert.throws(() => native().uiEditBatch(handle, '{"edits":[]}'), /no editor/);
});

test('ui.syncFunctions of the config reaches the command with the scripts made absolute, and a sync starts from every page with the hashes of its files', () => {
	const site = makeSite();
	writeFileSync(
		site.config,
		JSON.stringify({
			dir: { input: 'src', output: 'out' },
			build: { cacheDir: '.cache' },
			pages: { overrides: 'pages.overrides.json' },
			ui: {
				syncFunctions: [
					{
						name: 'import',
						label: { ja: '取り込む', en: 'Import' },
						script: './scripts/import.mjs',
					},
				],
			},
		}),
	);
	const handle = native().uiOpen(site.config, '{}');
	try {
		const settings = JSON.parse(native().uiServer(handle));
		assert.deepEqual(settings.syncFunctions, [
			{
				name: 'import',
				label: { ja: '取り込む', en: 'Import' },
				script: path.join(site.root, 'scripts', 'import.mjs'),
			},
		]);

		const sync = JSON.parse(native().uiSyncPages(handle));
		const rows = JSON.parse(native().uiPages(handle, query));
		assert.equal(sync.version, rows.version);
		assert.equal(sync.overridesHash, rows.overridesHash);
		assert.equal(sync.inputDir, path.join(site.root, 'src'));
		assert.equal(sync.overridesFile, path.join(site.root, 'pages.overrides.json'));
		assert.equal(sync.outputPathField, null);
		// every page, in the order of the plan, with the entry of `kamado pages` and the
		// hashes the rows give
		assert.deepEqual(
			sync.pages.map((page) => page.url),
			rows.pages.map((row) => row.url),
		);
		for (const [i, page] of sync.pages.entries()) {
			assert.deepEqual(page.hashes, rows.pages[i].hashes);
			for (const key of ['fileSlug', 'filePathStem', 'extension', 'depth', 'parent']) {
				assert.ok(key in page, `${key} of ${page.url}`);
			}
		}
		assert.equal(sync.pages.find((page) => page.url === '/ext/').virtual, true);
		// the keys that cannot be edited are asked for apart, for the pages named
		assert.ok(sync.pages.every((page) => !('locked' in page)));
		const locked = JSON.parse(
			native().uiSyncLocked(handle, JSON.stringify({ urls: ['/', '/nope/'] })),
		);
		assert.equal(locked.version, sync.version);
		assert.deepEqual(locked.locked, { '/': {} });
	} finally {
		native().uiClose(handle);
		rmSync(site.root, { recursive: true, force: true });
	}
});

test('a request for a sync of a handle that is not open throws', () => {
	assert.throws(() => native().uiSyncPages('0'), /no editor/);
	assert.throws(() => native().uiSyncPages(), /expected \(handle\) string/);
});

test('the window of a located page is told, and the key that places a page is a column and no sort', () => {
	const site = makeSite();
	const handle = native().uiOpen(site.config, '{}');
	try {
		const window = (extra) =>
			JSON.parse(
				native().uiPages(handle, JSON.stringify({ limit: 2, offset: 0, ...extra })),
			);
		// the plan is /, /about/, /about/history.html, /ext/: the page that is fourth is in the
		// window that starts at 2
		const located = window({ locate: '/ext/' });
		assert.equal(located.offset, 2);
		assert.deepEqual(
			located.pages.map((p) => p.url),
			['/about/history.html', '/ext/'],
		);
		assert.equal(window({ locate: '/nope/' }).offset, 0);
		assert.equal(window({ offset: 2 }).offset, 2);
		// the key `order` is a column, and refused as a sort (and so is the number of the place)
		assert.ok(window({}).columns.includes('order'));
		for (const key of ['order', 'meta:order']) {
			assert.throws(
				() =>
					native().uiPages(
						handle,
						JSON.stringify({ offset: 0, limit: 1, sort: { key } }),
					),
				/sort\.key/,
				key,
			);
		}
	} finally {
		native().uiClose(handle);
		rmSync(site.root, { recursive: true, force: true });
	}
});
