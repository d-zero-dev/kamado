/**
 * Data files that are scripts (RFC §3.2): the build and the dev server run them, a page is
 * rebuilt only when a key it read changed, and a file that fails fails only its readers.
 * Run through the built package, because the Node side runs the files and the core decides
 * what is stale: neither alone shows that the two agree.
 *
 * Run: `cargo build --release -p kd_napi`, `yarn build`, then
 * `node --test crates/kd_napi/check/data-scripts.check.mjs`. Not named `*.test.*` on purpose
 * so that vitest does not pick it up: it needs the native build.
 */
import assert from 'node:assert/strict';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
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
if (!existsSync(path.join(dist, 'build.js'))) {
	throw new Error(`${path.join(dist, 'build.js')} is not built: run yarn build first`);
}
const { build } = await import(pathToFileURL(path.join(dist, 'build.js')).href);
const { start } = await import(pathToFileURL(path.join(dist, 'index.js')).href);

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'kd-data-scripts-')));
after(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;

/**
 * A site with a page that reads `data.rates`, one that reads `data.other` and a data file
 * `rates.ts` that reads `rates.csv`.
 * @param extra - More members of the config
 */
function makeSite(extra = '') {
	const dir = path.join(root, `site${counter++}`);
	mkdirSync(path.join(dir, 'src'), { recursive: true });
	mkdirSync(path.join(dir, 'data'), { recursive: true });
	writeFileSync(path.join(dir, 'package.json'), '{}');
	writeFileSync(
		path.join(dir, 'src', 'rates.tsx'),
		'export default (p: any) => <html><body>rates:{String(p.data.rates.total)}</body></html>;\n',
	);
	writeFileSync(
		path.join(dir, 'src', 'other.tsx'),
		'export default (p: any) => <html><body>other:{String(p.data.other)}</body></html>;\n',
	);
	writeFileSync(path.join(dir, 'data', 'other.json'), '1');
	writeFileSync(path.join(dir, 'rates.csv'), '1\n2\n3\n');
	writeFileSync(
		path.join(dir, 'data', 'rates.ts'),
		[
			'export default async ({ readFile }: { readFile: (p: string) => Promise<string> }) => {',
			"	const text = await readFile('rates.csv');",
			'	return { total: text.trim().split("\\n").length };',
			'};',
			'',
		].join('\n'),
	);
	const config = path.join(dir, 'kamado.config.jsonc');
	writeFileSync(
		config,
		`{ "dir": { "input": "src", "output": "htdocs" }, "data": { "dir": "data" }, "build": { "cacheDir": ".cache", "incremental": true }${extra} }\n`,
	);
	return { dir, config };
}

/**
 * The status of each page of an incremental build, by output file name.
 * @param config - The config file
 */
async function statuses(config) {
	const report = await build(config, { incremental: true });
	return Object.fromEntries(
		report.pages.map((p) => [path.basename(p.outputPath), p.status]),
	);
}

test('a build runs the script and a page is rebuilt when a file the script read changes', async () => {
	const { dir, config } = makeSite();

	const first = await build(config, { incremental: true });
	assert.deepEqual(
		Object.fromEntries(first.pages.map((p) => [path.basename(p.outputPath), p.status])),
		{ 'rates.html': 'built', 'other.html': 'built' },
	);
	assert.match(readFileSync(path.join(dir, 'htdocs', 'rates.html'), 'utf8'), /rates:3/);
	assert.equal(first.data.length, 1);
	assert.match(first.data[0], /^data rates: ran \(\d+ms, hash [0-9a-f]{8}\)$/);

	// The script runs again, makes the same value, and no page is built again.
	assert.deepEqual(await statuses(config), {
		'rates.html': 'cached',
		'other.html': 'cached',
	});

	writeFileSync(path.join(dir, 'rates.csv'), '1\n2\n3\n4\n5\n');
	const third = await build(config, { incremental: true });
	assert.deepEqual(
		Object.fromEntries(third.pages.map((p) => [path.basename(p.outputPath), p.status])),
		{ 'rates.html': 'built', 'other.html': 'cached' },
	);
	assert.match(readFileSync(path.join(dir, 'htdocs', 'rates.html'), 'utf8'), /rates:5/);
	assert.match(third.data[0], /hash [0-9a-f]{8}\)$/);
	assert.ok(
		third.reasons.some(
			([url, why]) => url.includes('rates') && why === 'data.rates changed',
		),
		JSON.stringify(third.reasons),
	);
});

test('a change to a module that the script imports runs it again', async () => {
	const { dir, config } = makeSite();
	mkdirSync(path.join(dir, 'lib'));
	writeFileSync(
		path.join(dir, 'lib', 'shape.ts'),
		'export const shape = (n: number) => n;\n',
	);
	writeFileSync(
		path.join(dir, 'data', 'rates.ts'),
		"import { shape } from '../lib/shape.ts';\nexport default { total: shape(7) };\n",
	);
	await build(config, { incremental: true });
	assert.match(readFileSync(path.join(dir, 'htdocs', 'rates.html'), 'utf8'), /rates:7/);

	writeFileSync(
		path.join(dir, 'lib', 'shape.ts'),
		'export const shape = (n: number) => n + 1;\n',
	);
	assert.deepEqual(await statuses(config), {
		'rates.html': 'built',
		'other.html': 'cached',
	});
	assert.match(readFileSync(path.join(dir, 'htdocs', 'rates.html'), 'utf8'), /rates:8/);
});

test('a script that throws, times out or returns what is not JSON stops the build and names the file', async () => {
	const { dir, config } = makeSite();
	const write = (source) => writeFileSync(path.join(dir, 'data', 'rates.ts'), source);

	write("export default () => { throw new Error('no answer'); };\n");
	await assert.rejects(build(config), /rates\.ts: no answer/);

	write('export const timeout = 0.2;\nexport default () => new Promise(() => {});\n');
	await assert.rejects(build(config), /rates\.ts: it did not finish in 0\.2 seconds/);

	write('export default () => ({ at: new Date() });\n');
	await assert.rejects(
		build(config),
		/rates\.ts: the value is not JSON: \$\.at is a Date/,
	);

	write('export const maxAge = -1;\nexport default {};\n');
	await assert.rejects(build(config), /export const maxAge must be a positive number/);
});

test('the dev server runs the script, follows what it read, and keeps the last value when it fails', async () => {
	const { dir, config } = makeSite(', "devServer": { "port": 39518, "open": false }');
	const lines = [];
	const server = await start(config, { write: (text) => lines.push(text) });
	const get = async (page) => {
		const response = await fetch(`http://localhost:39518/${page}.html`);
		return { status: response.status, body: await response.text() };
	};
	const text = async (page) => {
		const got = await get(page);
		return got.body;
	};
	try {
		assert.match(await text('rates'), /rates:3/);

		writeFileSync(path.join(dir, 'rates.csv'), '1\n2\n3\n4\n');
		assert.match(await text('rates'), /rates:4/);
		assert.match(await text('other'), /other:1/);

		// A script that fails: the page keeps the last value and the server says so.
		writeFileSync(
			path.join(dir, 'data', 'rates.ts'),
			"export default () => { throw new Error('upstream is down'); };\n",
		);
		assert.match(await text('rates'), /rates:4/);
		assert.ok(
			lines.some((l) => l.includes('upstream is down') && l.includes('last value')),
		);
	} finally {
		await server.close();
	}
});

test('a script that has never run makes only its readers fail', async () => {
	const { dir, config } = makeSite(', "devServer": { "port": 39519, "open": false }');
	writeFileSync(
		path.join(dir, 'data', 'rates.ts'),
		"export default () => { throw new Error('upstream is down'); };\n",
	);
	const server = await start(config, { write: () => {} });
	try {
		const rates = await fetch('http://localhost:39519/rates.html');
		assert.equal(rates.status, 500);
		assert.match(await rates.text(), /data\.rates is not available.*upstream is down/);
		const other = await fetch('http://localhost:39519/other.html');
		assert.equal(other.status, 200);

		// It is fixed: the change to the file runs it again at the next request.
		writeFileSync(path.join(dir, 'data', 'rates.ts'), 'export default { total: 9 };\n');
		const fixed = await fetch('http://localhost:39519/rates.html');
		assert.match(await fixed.text(), /rates:9/);
	} finally {
		await server.close();
	}
});

test('a script with a maxAge runs again when it is older than that', async () => {
	const { dir, config } = makeSite(', "devServer": { "port": 39520, "open": false }');
	writeFileSync(
		path.join(dir, 'data', 'rates.ts'),
		'export const maxAge = 1;\nexport default () => ({ total: Math.random() });\n',
	);
	const server = await start(config, { write: () => {} });
	const get = async () => {
		const response = await fetch('http://localhost:39520/rates.html');
		return response.text();
	};
	try {
		const first = await get();
		assert.equal(await get(), first, 'young enough: the same page');
		await new Promise((resolve) => setTimeout(resolve, 1200));
		assert.notEqual(await get(), first, 'older than maxAge: run again');
	} finally {
		await server.close();
	}
});

test('a server starts from what the disk holds and runs the script only when it is out of date', async () => {
	const { dir, config } = makeSite(', "devServer": { "port": 39521, "open": false }');
	writeFileSync(
		path.join(dir, 'data', 'rates.ts'),
		'export default () => ({ total: Math.random() });\n',
	);
	await build(config);
	const built = readFileSync(path.join(dir, 'htdocs', 'rates.html'), 'utf8');
	const server = await start(config, { write: () => {} });
	try {
		const response = await fetch('http://localhost:39521/rates.html');
		const served = await response.text();
		const total = (html) => /rates:([0-9.]+)/.exec(html)?.[1];
		assert.equal(total(served), total(built), 'the value the build kept, not a new run');
	} finally {
		await server.close();
	}
});

test('every extension of a script runs, and a type declaration is not a data file', async () => {
	const { dir, config } = makeSite();
	writeFileSync(path.join(dir, 'data', 'm.mts'), 'export default 1;\n');
	writeFileSync(path.join(dir, 'data', 'j.js'), 'export default 2;\n');
	writeFileSync(path.join(dir, 'data', 'x.mjs'), 'export default 3;\n');
	writeFileSync(path.join(dir, 'data', 'types.d.ts'), 'export type T = number;\n');
	writeFileSync(
		path.join(dir, 'src', 'all.tsx'),
		'export default (p: any) => <html><body>{[p.data.m, p.data.j, p.data.x, String("types.d" in p.data)].join()}</body></html>;\n',
	);

	await build(config);

	assert.match(readFileSync(path.join(dir, 'htdocs', 'all.html'), 'utf8'), /1,2,3,false/);
});

test('the report file has what was decided about the data files', async () => {
	const { dir, config } = makeSite(
		', "build": { "cacheDir": ".cache", "report": "report.json" }',
	);
	writeFileSync(
		config,
		`{ "dir": { "input": "src", "output": "htdocs" }, "data": { "dir": "data" }, "build": { "cacheDir": ".cache", "report": "report.json" } }\n`,
	);

	await build(config);

	const report = JSON.parse(readFileSync(path.join(dir, 'report.json'), 'utf8'));
	assert.equal(report.data.length, 1);
	assert.match(report.data[0], /^data rates: ran \(\d+ms, hash [0-9a-f]{8}\)$/);
});

test('the dev server runs a data file that is added, and a file that was missing and appears', async () => {
	const { dir, config } = makeSite(', "devServer": { "port": 39522, "open": false }');
	writeFileSync(
		path.join(dir, 'data', 'rates.ts'),
		[
			'export default async ({ readFile }: { readFile: (p: string) => Promise<string> }) => {',
			"	let text = 'none';",
			"	try { text = await readFile('late.txt'); } catch {}",
			'	return { total: text.trim().length };',
			'};',
			'',
		].join('\n'),
	);
	writeFileSync(
		path.join(dir, 'src', 'added.tsx'),
		'export default (p: any) => <html><body>added:{String(p.data.added)}</body></html>;\n',
	);
	const server = await start(config, { write: () => {} });
	const get = async (page) => {
		const response = await fetch(`http://localhost:39522/${page}.html`);
		return response.text();
	};
	try {
		assert.match(await get('rates'), /rates:4/);
		writeFileSync(path.join(dir, 'late.txt'), '12345678');
		assert.match(await get('rates'), /rates:8/, 'the file that was missing appeared');

		assert.match(await get('added'), /added:undefined/);
		writeFileSync(path.join(dir, 'data', 'added.ts'), 'export default 5;\n');
		assert.match(await get('added'), /added:5/, 'a data file added while serving');
		rmSync(path.join(dir, 'data', 'added.ts'));
		assert.match(await get('added'), /added:undefined/, 'and removed');
	} finally {
		await server.close();
	}
});

test('a name that is nearly maxAge or timeout is refused, because it would be ignored', async () => {
	const { dir, config } = makeSite();
	writeFileSync(
		path.join(dir, 'data', 'rates.ts'),
		'export const maxage = 60;\nexport default { total: 1 };\n',
	);

	await assert.rejects(
		build(config),
		/export const maxage is not read: the names are maxAge and timeout/,
	);

	writeFileSync(
		path.join(dir, 'data', 'rates.ts'),
		'export const helper = 60;\nexport default { total: 1 };\n',
	);
	await build(config);
});

test('a data file whose default export is a Promise says to export a function', async () => {
	const { dir, config } = makeSite();
	writeFileSync(
		path.join(dir, 'data', 'rates.ts'),
		'export default Promise.resolve({ total: 1 });\n',
	);

	await assert.rejects(
		build(config),
		/the default export is a Promise: export a function/,
	);
});
