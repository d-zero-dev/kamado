/**
 * `select` and `write` of a sync script, through the built addon and the built Node side (RFC
 * §14.2, "同期"). The unit tests use an editor that is made up; this is where it is shown, with the
 * real core, that:
 *
 * 1. an import changes only what `select` names: the keys it leaves out and the pages it leaves
 *    out keep their bytes, and the same import run again finds nothing;
 * 2. an export writes nothing before it is confirmed, never touches the files of the site, and
 *    writes after it is confirmed, in the process that read;
 * 3. an export that waited does not write when a file of the site changed meanwhile, and does
 *    write when none did (the list the core gives is the same text twice, so that a comparison
 *    of the two finds a change only when there is one).
 *
 * Run: `cargo build --release -p kd_napi`, `yarn build`, then
 * `node --test crates/kd_napi/check/sync-select.check.mjs`. Not named `*.test.*` on purpose so that
 * vitest does not pick it up: it needs the native build.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
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
const scriptsDir = mkdtempSync(path.join(tmpdir(), 'kd-sync-select-scripts-'));
process.on('exit', () => rmSync(scriptsDir, { recursive: true, force: true }));

const { native } = await import(pathToFileURL(path.join(dist, 'native.js')).href);
const { prepareSync } = await import(
	pathToFileURL(path.join(dist, 'sync', 'session.js')).href
);

/**
 * A site with pages that have more keys than a sheet has columns.
 * @returns {{ root: string, config: string, write: (rel: string, text: string) => void, read: (rel: string) => string }} the site
 */
function makeSite() {
	const root = mkdtempSync(path.join(tmpdir(), 'kd-sync-select-'));
	const write = (rel, text) => {
		mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		writeFileSync(path.join(root, rel), text);
	};
	write(
		'kamado.config.jsonc',
		JSON.stringify({
			dir: { input: 'src', output: 'out' },
			build: { cacheDir: '.cache' },
		}),
	);
	write('src/index.html', '---\ntitle: Home\nlayout: top\n---\n<p>home</p>\n');
	write('src/about/index.html', '---\ntitle: About\nlayout: wide\n---\n<p>about</p>\n');
	write(
		'src/service/index.html',
		'---\ntitle: Service\nlayout: wide\n---\n<p>service</p>\n',
	);
	process.on('exit', () => rmSync(root, { recursive: true, force: true }));
	return {
		root,
		config: path.join(root, 'kamado.config.jsonc'),
		write,
		read: (rel) => readFileSync(path.join(root, rel), 'utf8'),
	};
}

/**
 * Every file under the site, by path, with a hash of its bytes.
 * @param {string} root
 */
function tree(root) {
	const out = {};
	const walk = (dir) => {
		for (const name of readdirSync(dir).toSorted()) {
			if (name === '.cache' || name === 'out') {
				continue;
			}
			const file = path.join(dir, name);
			if (statSync(file).isDirectory()) {
				walk(file);
			} else {
				out[path.relative(root, file)] = createHash('sha256')
					.update(readFileSync(file))
					.digest('hex');
			}
		}
	};
	walk(root);
	return out;
}

let count = 0;
/**
 * Writes a script, and gives its path.
 * @param {string} body
 */
function script(body) {
	const file = path.join(scriptsDir, `script-${count++}.mjs`);
	writeFileSync(file, body);
	return file;
}

/**
 * Opens the editor, runs the sync on a script, and lets the editor go when the test is over.
 * @param {ReturnType<typeof makeSite>} site
 * @param {string} file
 */
async function prepare(site, file) {
	const handle = native().uiOpen(site.config, '{}');
	const editor = { handle, ...native() };
	const prepared = await prepareSync({
		editor,
		script: file,
		cwd: site.root,
		refresh: true,
		onLog: () => {},
	});
	// A script of an export waits in its process: one that a failed check leaves would keep this
	// process from ending.
	if (prepared.kind === 'review' && prepared.direction === 'export') {
		process.on('exit', () => prepared.discard());
	}
	return { prepared, close: () => native().uiClose(handle) };
}

/** What a sheet of two columns reads: the title of every page, by its file. */
const SELECT_TITLE =
	"select: (pages) => pages.map((p) => ({ url: p.url, inputPath: p.inputPath, meta: { title: '' } })),";

test('an import with select changes the keys it names, keeps the others, and finds nothing the second time', async () => {
	const site = makeSite();
	const rows = [
		{ url: '/', inputPath: 'index.html', meta: { title: 'Home!' } },
		{ url: '/about/', inputPath: 'about/index.html', meta: { title: 'About' } },
		{ url: '/service/', inputPath: 'service/index.html', meta: { title: 'Service' } },
	];
	const file = script(
		`export default { ${SELECT_TITLE} read: () => ${JSON.stringify(rows)} };`,
	);
	const first = await prepare(site, file);
	assert.equal(first.prepared.kind, 'review', JSON.stringify(first.prepared));
	assert.deepEqual(
		first.prepared.summary.changes.map((c) => [c.kind, c.url, c.key]),
		[['meta', '/', 'title']],
	);
	const applied = first.prepared.apply();
	first.close();
	assert.equal(applied.ok, true, JSON.stringify(applied));
	// the title is the new one, and the key the sheet has no column for is as it was
	assert.match(site.read('src/index.html'), /title: Home!/u);
	assert.match(site.read('src/index.html'), /layout: top/u);
	assert.match(site.read('src/about/index.html'), /layout: wide/u);

	const second = await prepare(site, file);
	assert.equal(second.prepared.kind, 'nochange', JSON.stringify(second.prepared));
	second.close();
});

test('an import with select leaves a page out of the range alone, and removes one of the range that read does not give', async () => {
	const site = makeSite();
	const before = tree(site.root);
	const file = script(
		`export default {
			select: (pages) => pages.filter((p) => p.url === '/about/').map((p) => ({ url: p.url, inputPath: p.inputPath })),
			read: () => [],
		};`,
	);
	const run = await prepare(site, file);
	assert.equal(run.prepared.kind, 'review', JSON.stringify(run.prepared));
	assert.deepEqual(
		run.prepared.summary.changes.map((c) => [c.kind, c.url]),
		[['deleted', '/about/']],
	);
	const applied = run.prepared.apply();
	run.close();
	assert.equal(applied.ok, true, JSON.stringify(applied));
	const after = tree(site.root);
	assert.equal(after['src/about/index.html'], undefined);
	for (const [name, hash] of Object.entries(before)) {
		if (name !== 'src/about/index.html') {
			assert.equal(after[name], hash, `${name} must be as it was`);
		}
	}
});

/**
 * An export that writes a marker and tells the process that wrote it.
 * @param {string} rows - The code of what `read` returns
 */
function exporter(rows) {
	const marker = path.join(scriptsDir, `marker-${count++}`);
	const file = script(
		`import { writeFileSync } from 'node:fs';
		let learned = null;
		export default {
			// an export writes what select returns, so the value is the title the page has
			select: (pages) => pages.map((p) => ({ url: p.url, inputPath: p.inputPath, meta: { title: p.meta.title } })),
			read: async () => { learned = process.pid; return ${rows}; },
			write: async ({ rows }) => { writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, learned, rows })); },
		};`,
	);
	return { file, marker };
}

const OLD_TITLES = `[
	{ url: '/', inputPath: 'index.html', meta: { title: 'Home' } },
	{ url: '/about/', inputPath: 'about/index.html', meta: { title: 'Old about' } },
	{ url: '/service/', inputPath: 'service/index.html', meta: { title: 'Service' } },
]`;

test('an export writes nothing before it is confirmed, never changes the site, and writes in the process that read', async () => {
	const site = makeSite();
	const before = tree(site.root);
	const { file, marker } = exporter(OLD_TITLES);
	const run = await prepare(site, file);
	assert.equal(run.prepared.kind, 'review', JSON.stringify(run.prepared));
	assert.equal(run.prepared.direction, 'export');
	assert.equal(run.prepared.diffed, true);
	assert.deepEqual(
		run.prepared.summary.changes.map((c) => [c.kind, c.url, c.key, c.before, c.after]),
		[['meta', '/about/', 'title', 'Old about', 'About']],
	);
	assert.equal(existsSync(marker), false, 'nothing is written before the confirmation');
	// no conflict comes of a site nobody touched: the list read again is the list read first
	const written = await run.prepared.write();
	run.close();
	assert.deepEqual(written, { kind: 'written', count: 1 });
	const note = JSON.parse(readFileSync(marker, 'utf8'));
	assert.equal(note.pid, note.learned, 'write runs in the process that read');
	assert.deepEqual(
		note.rows.map((r) => [r.url, r.meta]),
		[
			['/', { title: 'Home' }],
			['/about/', { title: 'About' }],
			['/service/', { title: 'Service' }],
		],
	);
	assert.deepEqual(
		tree(site.root),
		before,
		'an export leaves every file of the site as it was',
	);
});

test('an export finds nothing when the outside is what the site has', async () => {
	const site = makeSite();
	const same = OLD_TITLES.replace('Old about', 'About');
	const { file, marker } = exporter(same);
	const run = await prepare(site, file);
	run.close();
	assert.equal(run.prepared.kind, 'nochange', JSON.stringify(run.prepared));
	assert.equal(existsSync(marker), false);
});

test('an export does not write when a page of the site changed while it waited', async () => {
	const site = makeSite();
	const { file, marker } = exporter(OLD_TITLES);
	const run = await prepare(site, file);
	assert.equal(run.prepared.kind, 'review', JSON.stringify(run.prepared));
	// somebody saves a page in an editor while the confirmation is open
	site.write(
		'src/service/index.html',
		'---\ntitle: Service!\nlayout: wide\n---\n<p>service</p>\n',
	);
	const written = await run.prepared.write();
	run.close();
	assert.equal(written.kind, 'conflict', JSON.stringify(written));
	assert.equal(existsSync(marker), false, 'nothing is written after a conflict');
});

test('an export that is discarded stops its script, and nothing is written', async () => {
	const site = makeSite();
	const { file, marker } = exporter(OLD_TITLES);
	const run = await prepare(site, file);
	assert.equal(run.prepared.kind, 'review', JSON.stringify(run.prepared));
	run.prepared.discard();
	const written = await run.prepared.write();
	run.close();
	assert.deepEqual(written, { kind: 'cancelled' });
	assert.equal(existsSync(marker), false);
});
