/**
 * A JSX page is rebuilt when a key of `data` that it read changes, and only then (RFC §11).
 * Run through the built package, because the recording is made by the renderer in Node and
 * the decision by the core: neither side alone shows that the two agree on the keys.
 *
 * Run: `cargo build --release -p kd_napi`, `yarn build`, then
 * `node --test crates/kd_napi/check/data-keys.check.mjs`. Not named `*.test.*` on purpose so
 * that vitest does not pick it up: it needs the native build.
 */
import assert from 'node:assert/strict';
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
if (!existsSync(path.join(dist, 'build.js'))) {
	throw new Error(`${path.join(dist, 'build.js')} is not built: run yarn build first`);
}
const { build } = await import(pathToFileURL(path.join(dist, 'build.js')).href);
const { start } = await import(pathToFileURL(path.join(dist, 'index.js')).href);

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'kd-data-keys-')));
after(() => rmSync(root, { recursive: true, force: true }));

const site = path.join(root, 'site');
mkdirSync(path.join(site, 'src'), { recursive: true });
mkdirSync(path.join(site, 'data'), { recursive: true });
writeFileSync(path.join(site, 'package.json'), '{}');
writeFileSync(
	path.join(site, 'src', 'a.tsx'),
	'export default (p: any) => <html><body>{p.data.alpha.n}</body></html>;\n',
);
writeFileSync(
	path.join(site, 'src', 'b.tsx'),
	'export default (p: any) => <html><body>{p.data.beta.n}</body></html>;\n',
);
writeFileSync(
	path.join(site, 'src', 'all.tsx'),
	'export default (p: any) => <html><body>{Object.keys(p.data).join()}</body></html>;\n',
);
const config = path.join(site, 'kamado.config.jsonc');
writeFileSync(
	config,
	'{ "dir": { "input": "src", "output": "htdocs" }, "data": { "dir": "data" }, "build": { "cacheDir": ".cache", "incremental": true } }\n',
);

/** The status of each page of a build, by output file name. */
async function statuses() {
	const report = await build(config, { incremental: true });
	return Object.fromEntries(
		report.pages.map((p) => [path.basename(p.outputPath), p.status]),
	);
}

test('a change to one key rebuilds the pages that read it and the pages that list every key', async () => {
	writeFileSync(path.join(site, 'data', 'alpha.json'), '{ "n": 1 }');
	writeFileSync(path.join(site, 'data', 'beta.json'), '{ "n": 1 }');
	assert.deepEqual(await statuses(), {
		'a.html': 'built',
		'b.html': 'built',
		'all.html': 'built',
	});
	assert.deepEqual(await statuses(), {
		'a.html': 'cached',
		'b.html': 'cached',
		'all.html': 'cached',
	});

	writeFileSync(path.join(site, 'data', 'beta.json'), '{ "n": 2 }');
	const report = await build(config, { incremental: true });
	assert.deepEqual(
		Object.fromEntries(report.pages.map((p) => [path.basename(p.outputPath), p.status])),
		{ 'a.html': 'cached', 'b.html': 'built', 'all.html': 'built' },
	);
	// `--verbose` says why, by the name of the key and not by its value.
	assert.deepEqual(Object.fromEntries(report.reasons), {
		'/b.html': 'data.beta changed',
		'/all.html': 'the page depends on every key of data, and data changed',
	});
});

/**
 * Writes a site whose pages share a module, and returns the path of its config.
 * @param {string} name - The directory name of the site
 * @param {string} shared - The source of the module both pages import
 */
function sharedSite(name, shared) {
	const dir = path.join(root, name);
	mkdirSync(path.join(dir, 'src', '_lib'), { recursive: true });
	writeFileSync(path.join(dir, 'package.json'), '{}');
	writeFileSync(path.join(dir, 'src', '_lib', 'shared.ts'), shared);
	for (const page of ['one', 'two']) {
		writeFileSync(
			path.join(dir, 'src', `${page}.tsx`),
			"import { next } from './_lib/shared';\nexport default () => <html><body>{next()}</body></html>;\n",
		);
	}
	const file = path.join(dir, 'kamado.config.jsonc');
	writeFileSync(
		file,
		'{ "dir": { "input": "src", "output": "htdocs" }, "pages": { "ignore": ["_lib/**"] }, "build": { "cacheDir": ".cache" } }\n',
	);
	return file;
}

test('--verify-deps accepts pages that depend on their props only', async () => {
	const file = sharedSite('pure', 'export const next = () => 1;\n');

	const report = await build(file, { verifyDeps: true });

	assert.equal(report.pages.length, 2);
});

test('--verify-deps fails when a page depends on what another page left in a module', async () => {
	const file = sharedSite('leaky', 'let n = 0;\nexport const next = () => n++;\n');

	await assert.rejects(
		build(file, { verifyDeps: true }),
		/rendered differently in a fresh worker/,
	);
	// Without the flag the build passes: that is what the flag is for.
	const report = await build(file, {});
	assert.equal(report.pages.length, 2);
});

test('the keys read in the render workers reach the core (many pages)', async () => {
	// More pages than the renderer takes on its own thread: they go to workers.
	const dir = path.join(root, 'many');
	mkdirSync(path.join(dir, 'src'), { recursive: true });
	mkdirSync(path.join(dir, 'data'), { recursive: true });
	writeFileSync(path.join(dir, 'package.json'), '{}');
	writeFileSync(path.join(dir, 'data', 'alpha.json'), '{ "n": 1 }');
	writeFileSync(path.join(dir, 'data', 'beta.json'), '{ "n": 1 }');
	for (let i = 0; i < 40; i++) {
		writeFileSync(
			path.join(dir, 'src', `p${i}.tsx`),
			'export default (p: any) => <html><body>{p.data.alpha.n}</body></html>;\n',
		);
	}
	const file = path.join(dir, 'kamado.config.jsonc');
	writeFileSync(
		file,
		'{ "dir": { "input": "src", "output": "htdocs" }, "data": { "dir": "data" }, "build": { "cacheDir": ".cache", "incremental": true } }\n',
	);
	const count = async () => {
		const report = await build(file, { incremental: true });
		return report.pages.filter((p) => p.status === 'built').length;
	};

	assert.equal(await count(), 40);
	// A key no page read: if the reads were lost, every page would depend on every key.
	writeFileSync(path.join(dir, 'data', 'beta.json'), '{ "n": 2 }');
	assert.equal(await count(), 0);
	writeFileSync(path.join(dir, 'data', 'alpha.json'), '{ "n": 2 }');
	assert.equal(await count(), 40);
});

test('the dev server renders a page again only when a key it read changed', async () => {
	const dir = path.join(root, 'serve');
	mkdirSync(path.join(dir, 'src'), { recursive: true });
	mkdirSync(path.join(dir, 'layouts'), { recursive: true });
	mkdirSync(path.join(dir, 'data'), { recursive: true });
	writeFileSync(path.join(dir, 'package.json'), '{}');
	writeFileSync(path.join(dir, 'data', 'alpha.json'), '1');
	writeFileSync(path.join(dir, 'data', 'beta.json'), '1');
	// The random number is the sign of a render: a page served from the cache has the same one.
	const stamp = '{Math.random()}';
	writeFileSync(
		path.join(dir, 'src', 'a.tsx'),
		`export const meta = { layout: 'plain' };\nexport default (p: any) => <p>a:{p.data.alpha}:${stamp}</p>;\n`,
	);
	writeFileSync(
		path.join(dir, 'src', 'b.tsx'),
		`export default (p: any) => <html><body>b:{p.data.beta}:${stamp}</body></html>;\n`,
	);
	writeFileSync(
		path.join(dir, 'src', 'ghost.tsx'),
		`export default (p: any) => <html><body>ghost:{String(p.data.ghost)}:${stamp}</body></html>;\n`,
	);
	writeFileSync(
		path.join(dir, 'src', 'all.tsx'),
		`export default (p: any) => <html><body>all:{Object.keys(p.data).join()}:${stamp}</body></html>;\n`,
	);
	// The layout reads another key than the page does: the page depends on both.
	writeFileSync(
		path.join(dir, 'layouts', 'plain.tsx'),
		'export default (p: any) => <html><body>{p.content}|layout:{p.data.beta}</body></html>;\n',
	);
	const file = path.join(dir, 'kamado.config.jsonc');
	const port = 39_517;
	writeFileSync(
		file,
		`{ "dir": { "input": "src", "output": "htdocs" }, "pages": { "layouts": { "dir": "layouts" } }, "data": { "dir": "data" }, "devServer": { "port": ${port}, "open": false }, "build": { "cacheDir": ".cache" } }\n`,
	);
	const server = await start(file, { write: () => {} });
	try {
		const get = async (page) => {
			const response = await fetch(`http://localhost:${port}/${page}.html`);
			return response.text();
		};
		const pages = ['a', 'b', 'ghost', 'all'];
		const first = {};
		for (const page of pages) {
			first[page] = await get(page);
		}
		for (const page of pages) {
			assert.equal(await get(page), first[page], `${page} is served from the cache`);
		}

		// `alpha` is read by `a` and by the pages that list the keys. (A different size, because
		// the dev server tells a change by the size and the modification time.)
		writeFileSync(path.join(dir, 'data', 'alpha.json'), '22');
		const second = {};
		for (const page of pages) {
			second[page] = await get(page);
		}
		assert.notEqual(second.a, first.a);
		assert.match(second.a, /a:22:/);
		assert.equal(second.b, first.b, 'b did not read alpha');
		assert.equal(second.ghost, first.ghost, 'ghost did not read alpha');
		assert.notEqual(second.all, first.all, 'all lists every key');

		// `beta` is read by `b`, and by the layout of `a`.
		writeFileSync(path.join(dir, 'data', 'beta.json'), '333');
		const third = {};
		for (const page of pages) {
			third[page] = await get(page);
		}
		assert.notEqual(third.b, second.b);
		assert.notEqual(third.a, second.a, 'a depends on the key its layout read');
		assert.equal(third.ghost, second.ghost);

		// A key that was missing and appears.
		writeFileSync(path.join(dir, 'data', 'ghost.json'), '4444');
		const fourth = await get('ghost');
		assert.notEqual(fourth, third.ghost);
		assert.match(fourth, /ghost:4444:/);
		// ...and disappears again.
		rmSync(path.join(dir, 'data', 'ghost.json'));
		assert.match(await get('ghost'), /ghost:undefined:/);
	} finally {
		await server.close();
	}
});
