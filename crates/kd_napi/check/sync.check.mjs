/**
 * A sync through the built addon and the built Node side (RFC §14.2, "同期"): the pages are listed
 * by the core, a script is run in a process of its own, the difference is found, and the edits are
 * applied by the core as one batch. The unit tests of `diff.ts` and `session.ts` use a core that is
 * made up; this is where the laws that make a sync right are shown to hold with the real one:
 *
 * 1. what a script is given and returns unchanged changes nothing;
 * 2. what is applied makes the pages what the script returned (url, virtual, metadata);
 * 3. what was applied, returned again, changes nothing;
 * 4. a script that fails, or a file that changes meanwhile, leaves every byte as it was;
 * 5. a value or a key written as the worst text it can be is read back as it was written.
 *
 * The cases of (2) and (3) are made from a seed, so that a failure is the same on every run and
 * says which seed it was.
 *
 * Run: `cargo build --release -p kd_napi`, `yarn build`, then
 * `node --test crates/kd_napi/check/sync.check.mjs`. Not named `*.test.*` on purpose so that vitest
 * does not pick it up: it needs the native build.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
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
/** Where the scripts are: not in the site, whose bytes a refused sync must leave as they were. */
const scriptsDir = mkdtempSync(path.join(tmpdir(), 'kd-sync-scripts-'));
process.on('exit', () => rmSync(scriptsDir, { recursive: true, force: true }));

const { native } = await import(pathToFileURL(path.join(dist, 'native.js')).href);
const { prepareSync } = await import(
	pathToFileURL(path.join(dist, 'sync', 'session.js')).href
);

/**
 * A small generator that gives the same numbers for the same seed.
 * @param seed
 */
function random(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 1_831_565_813) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

const HOSTILE_VALUES = [
	'plain',
	'quote"s',
	"it's",
	'back`tick',
	'${interpolated}',
	'*/ end of comment',
	'line\nbreak',
	'---',
	'a: b',
	'# not a comment',
	'__proto__',
	'</script>',
	'ü日本語😀',
	'back\\slash',
	'',
	' padded ',
	'null',
	'true',
	'123',
	1,
	2.5,
	-3,
	true,
	false,
	null,
	['a', 'b', "c'd"],
	[],
	{ k: 'v', n: [1, { deep: '"' }] },
	{},
	'cr\r\nlf',
	'tab\there',
	'yes',
	'no',
	'~',
	'0x1f',
	'1e3',
	'- x',
	'*alias',
	'&anchor',
	'!tag',
	'|',
	'>',
	'%x',
	'@x',
	' ',
	'x'.repeat(3000),
	Number.MAX_SAFE_INTEGER,
];

/**
 * A site with an HTML page with a sidecar, HTML pages in directories, a TSX page, and a
 * `pages.overrides` file with a virtual page and an entry of a page that has a file.
 * @param {object} [config] - Added to the config
 * @returns {{ root: string, config: string, write: (rel: string, text: string) => void, read: (rel: string) => string }} the site
 */
function makeSite(config = {}) {
	const root = mkdtempSync(path.join(tmpdir(), 'kd-sync-'));
	const write = (rel, text) => {
		mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
		writeFileSync(path.join(root, rel), text);
	};
	write(
		'kamado.config.jsonc',
		JSON.stringify({
			dir: { input: 'src', output: 'out' },
			build: { cacheDir: '.cache' },
			pages: { overrides: 'pages.overrides.json', ...config.pages },
		}),
	);
	write('src/index.html', '---\ntitle: Home\nlayout: top\n---\n<p>home</p>\n');
	write('src/index.json', '{\n\t// the side\n\t"order": 1\n}\n');
	write('src/about/index.html', '---\ntitle: About\n---\n<p>about</p>\n');
	write(
		'src/about/history.html',
		'---\ntitle: History\ntags: [a, b]\n---\n<p>history</p>\n',
	);
	write('src/service/index.html', '---\ntitle: Service\n---\n<p>service</p>\n');
	write(
		'src/news/item.tsx',
		"export const meta = { title: 'News', n: 1 };\nexport default () => null;\n",
	);
	write(
		'pages.overrides.json',
		'{\n\t"version": 1,\n\t"pages": [\n\t\t{ "url": "/about/", "meta": { "navHidden": false } },\n\t\t{ "url": "/ext/", "virtual": true, "meta": { "title": "Ext", "flag": true } },\n\t\t{ "url": "/ext2/", "virtual": true }\n\t]\n}\n',
	);
	return {
		root,
		config: path.join(root, 'kamado.config.jsonc'),
		write,
		read: (rel) => readFileSync(path.join(root, rel), 'utf8'),
	};
}

/**
 * Every file under a directory, by path, with a hash of its bytes: what a refused sync must leave
 * exactly as it was (the cache and the output are not part of the site).
 * @param {string} root - The site
 * @returns {Record<string, string>} the files
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

/**
 * Opens the editor, and gives what the sync needs of it and the means to let it go.
 * @param site
 */
function open(site) {
	const handle = native().uiOpen(site.config, '{}');
	return {
		handle,
		editor: { handle, ...native() },
		pages: () => JSON.parse(native().uiSyncPages(handle)),
		close: () => native().uiClose(handle),
	};
}

let scriptCount = 0;
/**
 * Writes a script that returns `rows` (or runs `body`), and gives its path.
 * @param site
 * @param rows
 */
function scriptReturning(site, rows) {
	const file = path.join(scriptsDir, `script-${scriptCount++}.mjs`);
	writeFileSync(file, `export default async () => ${JSON.stringify(rows)};`);
	return file;
}

const prepare = (opened, site, file, extra = {}) =>
	prepareSync({
		editor: opened.editor,
		script: file,
		cwd: site.root,
		onLog: () => {},
		...extra,
	});

/**
 * What a script is given: the entries of `kamado pages`, without the hashes and the locks.
 * @param snapshot
 */
const given = (snapshot) =>
	snapshot.pages.map((page) =>
		Object.fromEntries(
			Object.entries(page).filter(([key]) => key !== 'hashes' && key !== 'locked'),
		),
	);

test('law 1: the pages returned as they were given change nothing', async () => {
	const site = makeSite();
	const opened = open(site);
	try {
		const before = tree(site.root);
		const prepared = await prepare(
			opened,
			site,
			scriptReturning(site, given(opened.pages())),
		);
		assert.equal(prepared.kind, 'nochange');
		assert.deepEqual(tree(site.root), before);
		// by the url alone is the same
		const urls = opened.pages().pages.map((page) => ({ url: page.url }));
		const byUrl = await prepare(opened, site, scriptReturning(site, urls));
		assert.equal(byUrl.kind, 'nochange');
	} finally {
		opened.close();
		rmSync(site.root, { recursive: true, force: true });
	}
});

/**
 * Makes the rows a script returns from the pages the site has, by what a seed says: each page is
 * kept, removed, moved to another URL, made virtual, given its file, or given other metadata;
 * some pages trade URLs; and pages are added. Only what the core can make is asked.
 * @param {ReturnType<typeof random>} next - The numbers
 * @param {object} snapshot - What the core listed
 * @returns {{ rows: object[], exchanged: boolean }} the rows, and whether two pages trade urls
 */
function rowsFrom(next, snapshot) {
	let exchanged = false;
	const pick = (items) => items[Math.floor(next() * items.length)];
	const rows = [];
	// the body each page that keeps its file must have afterwards, by the url it ends with
	const bodies = new Map();
	const markerOf = (page) => {
		if (page.virtual || page.extension !== '.html') {
			return;
		}
		return /<p>([^<]*)<\/p>/u.exec(readFileSync(page.inputPath, 'utf8'))?.[1];
	};
	let counter = 0;
	// urls of every shape a page can have: a directory, a file, a name that is not ASCII, a depth
	const fresh = () => {
		const n = counter++;
		return pick([`/gen${n}/`, `/gen${n}.html`, `/ゲン${n}/`, `/deep/gen/${n}/`]);
	};
	const placeOf = (url) =>
		url.endsWith('/') ? `${url.slice(1)}index.html` : url.slice(1);
	const pages = snapshot.pages.filter((page) => page.url !== '/');
	const root = snapshot.pages.find((page) => page.url === '/');
	const remaining = [...(root ? [root] : []), ...pages];
	const removed = [];
	const moved = [];
	// two pages that trade urls
	if (next() < 0.25) {
		const files = remaining.filter((page) => !page.virtual && page.url !== '/');
		if (files.length >= 2) {
			const [a, b] = [files[0], files[1]];
			const relative = (page) => path.relative(snapshot.inputDir, page.inputPath);
			const c = files.length >= 3 && next() < 0.4 ? files[2] : undefined;
			if (c === undefined) {
				rows.push(
					{ url: b.url, inputPath: relative(a) },
					{ url: a.url, inputPath: relative(b) },
				);
				bodies.set(b.url, markerOf(a));
				bodies.set(a.url, markerOf(b));
			} else {
				// three pages that pass their urls round
				rows.push(
					{ url: b.url, inputPath: relative(a) },
					{ url: c.url, inputPath: relative(b) },
					{ url: a.url, inputPath: relative(c) },
				);
				bodies.set(b.url, markerOf(a));
				bodies.set(c.url, markerOf(b));
				bodies.set(a.url, markerOf(c));
				remaining.splice(remaining.indexOf(c), 1);
			}
			remaining.splice(remaining.indexOf(a), 1);
			remaining.splice(remaining.indexOf(b), 1);
			exchanged = true;
		}
	}
	for (const page of remaining) {
		const roll = next();
		const relative =
			page.inputPath === null ? null : path.relative(snapshot.inputDir, page.inputPath);
		let row = { url: page.url };
		if (page.virtual) {
			row.virtual = true;
		} else {
			row.inputPath = relative;
		}
		if (roll < 0.1 && page.url !== '/') {
			removed.push(page.url);
			continue; // removed
		}
		if (roll < 0.25 && page.url !== '/' && !page.virtual) {
			row.url = fresh(); // the url moves, the file is the same page
			moved.push({ row, page });
		} else if (roll < 0.33 && !page.virtual) {
			row = { url: page.url, virtual: true }; // virtual
		} else if (roll < 0.43 && page.virtual) {
			row = { url: page.url, virtual: false }; // given its file
		} else if (roll < 0.5 && page.virtual && page.url !== '/') {
			row = { url: fresh(), virtual: true }; // a virtual page that is somewhere else is another page
		}
		if (next() < 0.5) {
			const meta = structuredClone(page.meta);
			const keys = Object.keys(meta);
			const change = next();
			if (change < 0.35 && keys.length > 0) {
				meta[pick(keys)] = pick(HOSTILE_VALUES);
			} else if (change < 0.7) {
				meta[`added${Math.floor(next() * 4)}`] = pick(HOSTILE_VALUES);
			} else if (keys.length > 0 && change < 0.9) {
				delete meta[pick(keys)];
			} else {
				// every key goes
				for (const key of keys) {
					delete meta[key];
				}
			}
			row.meta = meta;
		}
		rows.push(row);
	}
	// a page that moves to the url of a page that goes: the place is free once the batch is made
	if (removed.length > 0 && moved.length > 0 && next() < 0.6) {
		const { row } = moved[0];
		const taken = rows.some((other) => other.url === removed[0]);
		if (!taken) {
			row.url = removed[0];
		}
	}
	for (const row of rows) {
		const page = snapshot.pages.find(
			(candidate) =>
				!candidate.virtual &&
				row.inputPath !== undefined &&
				path.relative(snapshot.inputDir, candidate.inputPath ?? '') === row.inputPath,
		);
		if (page !== undefined && row.virtual !== true && !bodies.has(row.url)) {
			bodies.set(row.url, markerOf(page));
		}
	}
	// pages that are new
	const additions = Math.floor(next() * 4);
	for (let i = 0; i < additions; i += 1) {
		const kind = next();
		const url = fresh();
		const meta =
			next() < 0.6 ? { title: pick(HOSTILE_VALUES), n: pick(HOSTILE_VALUES) } : undefined;
		if (kind < 0.35) {
			rows.push({ url, virtual: true, ...(meta ? { meta } : {}) });
		} else if (kind < 0.7) {
			rows.push({
				url,
				virtual: false,
				inputPath: placeOf(url),
				...(meta ? { meta } : {}),
			});
		} else {
			rows.push({ url, virtual: false, ...(meta ? { meta } : {}) });
		}
	}
	// the order of the rows means nothing
	for (let i = rows.length - 1; i > 0; i -= 1) {
		const j = Math.floor(next() * (i + 1));
		[rows[i], rows[j]] = [rows[j], rows[i]];
	}
	return { rows, exchanged, bodies };
}

/**
 * The difference between what the pages are now and what was returned, in the terms of law 2:
 * the same urls, the virtual flag where it was given, and the metadata where it was given.
 * @param {object} snapshot - The pages now
 * @param {object[]} rows - What the script returned
 * @returns {string[]} what differs
 */
function differences(snapshot, rows) {
	const out = [];
	const now = new Map(snapshot.pages.map((page) => [page.url, page]));
	for (const row of rows) {
		const page = now.get(row.url);
		if (page === undefined) {
			out.push(`${row.url} is missing`);
			continue;
		}
		if (row.virtual !== undefined && page.virtual !== row.virtual) {
			out.push(`${row.url} virtual is ${page.virtual}, not ${row.virtual}`);
		}
		if (row.meta !== undefined) {
			try {
				assert.deepEqual(page.meta, row.meta);
			} catch (error) {
				out.push(
					`${row.url} meta: ${error.message.split('\n').slice(0, 12).join(' | ')}`,
				);
			}
		}
	}
	const returned = new Set(rows.map((row) => row.url));
	for (const url of now.keys()) {
		if (!returned.has(url)) {
			out.push(`${url} is there and was not returned`);
		}
	}
	return out;
}

const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1);

/** How many changes of each kind the seeds made: a law that is checked on nothing shows nothing. */
const made = {};
let seedsRun = 0;

for (const seed of SEEDS) {
	test(`laws 2 and 3: seed ${seed} is applied as the script returned it, and returned again changes nothing`, async () => {
		const site = makeSite();
		const opened = open(site);
		try {
			const { rows, exchanged, bodies } = rowsFrom(random(seed), opened.pages());
			const file = scriptReturning(site, rows);
			const prepared = await prepare(opened, site, file);
			seedsRun += 1;
			if (prepared.kind === 'nochange') {
				made.nochange = (made.nochange ?? 0) + 1;
				assert.deepEqual(differences(opened.pages(), rows), []);
				return;
			}
			assert.equal(
				prepared.kind,
				'review',
				`seed ${seed}: ${JSON.stringify(prepared.problems ?? prepared.message)}`,
			);
			for (const [kind, count] of Object.entries(prepared.summary.counts)) {
				made[kind] = (made[kind] ?? 0) + count;
			}
			if (exchanged) {
				made.exchanged = (made.exchanged ?? 0) + 1;
			}
			const applied = prepared.apply();
			assert.equal(
				applied.ok,
				true,
				`seed ${seed}: the core refused: ${JSON.stringify(applied)}\nrows: ${JSON.stringify(rows)}`,
			);
			// law 2
			assert.deepEqual(
				differences(opened.pages(), rows),
				[],
				`seed ${seed}\nrows: ${JSON.stringify(rows)}`,
			);
			// no page that keeps its file loses its body, whatever moved around it
			const after = opened.pages();
			for (const [url, marker] of bodies) {
				if (marker === undefined) {
					continue;
				}
				const kept = after.pages.find((page) => page.url === url);
				assert.ok(kept && !kept.virtual, `seed ${seed}: ${url} has a file`);
				assert.ok(
					readFileSync(kept.inputPath, 'utf8').includes(`<p>${marker}</p>`),
					`seed ${seed}: the body of ${url} is not ${marker} any more\nrows: ${JSON.stringify(rows)}`,
				);
			}
			// law 3: the same rows again. Not for two pages that traded urls: after the trade the
			// list holds the same pairs of url and file as before it, so the rows (which name
			// the pairs the pages had before) say the same thing as they did and trade the pages
			// again. A script that returns what it is given, as it is each time, does not meet this.
			if (exchanged) {
				return;
			}
			const again = await prepare(opened, site, file);
			assert.equal(
				again.kind,
				'nochange',
				`seed ${seed}: returned again it is ${again.kind}: ${JSON.stringify(again.summary?.changes ?? again.problems ?? again.message)}\nrows: ${JSON.stringify(rows)}`,
			);
			// and what is on disk is what a new editor reads (nothing is only in memory)
			const fresh = open(site);
			try {
				assert.deepEqual(differences(fresh.pages(), rows), []);
			} finally {
				fresh.close();
			}
		} finally {
			opened.close();
			rmSync(site.root, { recursive: true, force: true });
		}
	});
}

test('the seeds made every kind of change, in numbers that mean something', (t) => {
	if (seedsRun !== SEEDS.length) {
		// run by itself (a test name pattern): there is nothing counted to look at
		t.skip('the seeds were not all run');
		return;
	}
	for (const kind of [
		'added',
		'deleted',
		'movedUrl',
		'virtualized',
		'materialized',
		'meta',
		'exchanged',
	]) {
		assert.ok(
			(made[kind] ?? 0) >= 5,
			`${kind}: ${made[kind] ?? 0} in ${SEEDS.length} seeds`,
		);
	}
});

test('law 4: a script that fails leaves every byte as it was, whichever way it fails', async () => {
	const site = makeSite();
	const opened = open(site);
	try {
		const before = tree(site.root);
		for (const [body, kind] of [
			['export default async () => { throw new Error("no sheet"); };', 'failed'],
			['export default async () => { process.exit(0); };', 'failed'],
			['export default async () => ({ url: "/x/" });', 'failed'],
			['export default 5;', 'failed'],
			['export default async () => [{ url: "/x/" }, { url: "no-slash" }];', 'invalid'],
		]) {
			const file = path.join(scriptsDir, `fail-${scriptCount++}.mjs`);
			writeFileSync(file, body);
			const prepared = await prepare(opened, site, file);
			assert.equal(prepared.kind, kind, body);
			assert.deepEqual(tree(site.root), before);
		}
	} finally {
		opened.close();
		rmSync(site.root, { recursive: true, force: true });
	}
});

test('law 4: a file that changes after the script was given the pages makes the whole sync refuse, and nothing is written', async () => {
	const site = makeSite();
	const opened = open(site);
	try {
		const snapshot = opened.pages();
		const rows = given(snapshot).map((page) =>
			page.url === '/about/'
				? { ...page, url: '/about-moved/' }
				: page.url === '/service/'
					? { ...page, meta: { title: 'Changed' } }
					: page,
		);
		const prepared = await prepare(opened, site, scriptReturning(site, rows));
		assert.equal(prepared.kind, 'review');
		// a person edits a file meanwhile
		site.write('src/service/index.html', '---\ntitle: Edited meanwhile\n---\n');
		const before = tree(site.root);
		const applied = prepared.apply();
		assert.equal(applied.ok, false);
		assert.equal(applied.code, 'conflict');
		assert.deepEqual(tree(site.root), before);
		// a refused batch does not leave the editor of the screen on pages that are not there
		const again = await prepare(opened, site, scriptReturning(site, rows), {
			refresh: true,
		});
		assert.equal(again.kind, 'review');
		assert.equal(again.apply().ok, true);
	} finally {
		opened.close();
		rmSync(site.root, { recursive: true, force: true });
	}
});

test('law 4: a batch the core refuses halfway leaves every byte as it was, and the edits before the refused one are not kept', async () => {
	const site = makeSite();
	const opened = open(site);
	try {
		// A change of a key that is fine, a page that goes, and a page made at a file that is not a
		// page (a sidecar): the difference cannot see that last one is wrong, and the core finds it
		// while the batch is made.
		const rows = [
			...given(opened.pages())
				.filter((page) => page.url !== '/service/')
				.map((page) =>
					page.url === '/about/'
						? { ...page, meta: { ...page.meta, title: 'Changed' } }
						: page,
				),
			{ url: '/new/', virtual: false, inputPath: 'index.json' },
		];
		const before = tree(site.root);
		const prepared = await prepare(opened, site, scriptReturning(site, rows));
		assert.equal(
			prepared.kind,
			'review',
			JSON.stringify(prepared.problems ?? prepared.message),
		);
		const applied = prepared.apply();
		assert.equal(
			applied.ok,
			false,
			'the core must refuse a page made at the file of a sidecar',
		);
		assert.deepEqual(tree(site.root), before);
		// the editor still has the pages it had
		assert.ok(opened.pages().pages.some((page) => page.url === '/service/'));
	} finally {
		opened.close();
		rmSync(site.root, { recursive: true, force: true });
	}
});

test('law 4: a file that is changed after the script was given the pages makes the sync refuse, whichever file it is', async () => {
	const variants = {
		'the sidecar of a page whose key is changed': (site) =>
			site.write('src/index.json', '{ "order": 99 }\n'),
		'pages.overrides, which a page that goes has an entry in or may have': (site) =>
			site.write('pages.overrides.json', `${site.read('pages.overrides.json')}\n`),
		'the file of a page that goes': (site) =>
			site.write(
				'src/service/index.html',
				'---\ntitle: Meanwhile\n---\n<p>meanwhile</p>\n',
			),
		'the file of a page whose key is changed': (site) =>
			site.write('src/about/index.html', '---\ntitle: Meanwhile\n---\n<p>about</p>\n'),
	};
	for (const [name, change] of Object.entries(variants)) {
		const site = makeSite();
		const opened = open(site);
		try {
			const rows = [
				...given(opened.pages())
					.filter((page) => page.url !== '/service/')
					.map((page) =>
						page.url === '/' || page.url === '/about/'
							? { ...page, meta: { ...page.meta, title: 'Changed' } }
							: page,
					),
				{ url: '/fresh/', virtual: false, inputPath: 'fresh/index.html' },
			];
			const prepared = await prepare(opened, site, scriptReturning(site, rows));
			assert.equal(prepared.kind, 'review', name);
			change(site);
			const before = tree(site.root);
			const applied = prepared.apply();
			assert.equal(applied.ok, false, name);
			assert.equal(applied.code, 'conflict', name);
			assert.deepEqual(tree(site.root), before, name);
		} finally {
			opened.close();
			rmSync(site.root, { recursive: true, force: true });
		}
	}
	// a file that appears where a page is to be made is not written over
	const site = makeSite();
	const opened = open(site);
	try {
		const rows = [
			...given(opened.pages()),
			{ url: '/fresh/', virtual: false, inputPath: 'fresh/index.html' },
		];
		const prepared = await prepare(opened, site, scriptReturning(site, rows));
		assert.equal(prepared.kind, 'review');
		site.write('src/fresh/index.html', 'written meanwhile\n');
		const before = tree(site.root);
		assert.equal(prepared.apply().ok, false);
		assert.deepEqual(tree(site.root), before);
		assert.equal(site.read('src/fresh/index.html'), 'written meanwhile\n');
	} finally {
		opened.close();
		rmSync(site.root, { recursive: true, force: true });
	}
});

test('two pages that trade urls trade their files, the pairs of url and file are the same afterwards, and the same rows trade them again', async () => {
	const site = makeSite();
	const opened = open(site);
	try {
		const pairs = () =>
			opened
				.pages()
				.pages.map(
					(page) =>
						`${page.url} ${page.inputPath === null ? '-' : path.relative(opened.pages().inputDir, page.inputPath)}`,
				)
				.toSorted();
		const before = pairs();
		const snapshot = opened.pages();
		const about = snapshot.pages.find((p) => p.url === '/about/');
		const service = snapshot.pages.find((p) => p.url === '/service/');
		const relative = (page) => path.relative(snapshot.inputDir, page.inputPath);
		const rows = given(snapshot).map((entry) =>
			entry.url === '/about/'
				? { url: '/service/', inputPath: relative(about) }
				: entry.url === '/service/'
					? { url: '/about/', inputPath: relative(service) }
					: entry,
		);
		const file = scriptReturning(site, rows);
		const first = await prepare(opened, site, file);
		assert.equal(first.kind, 'review');
		assert.equal(first.apply().ok, true);
		// the contents were traded, and the list of pairs is what it was
		assert.ok(site.read('src/about/index.html').includes('<p>service</p>'));
		assert.ok(site.read('src/service/index.html').includes('<p>about</p>'));
		assert.deepEqual(pairs(), before);
		// the rows name the pairs the pages had before the trade, so they trade the pages again
		const again = await prepare(opened, site, file);
		assert.equal(again.kind, 'review');
		assert.deepEqual(again.summary.counts.movedUrl, 2);
		assert.equal(again.apply().ok, true);
		assert.ok(site.read('src/about/index.html').includes('<p>about</p>'));
	} finally {
		opened.close();
		rmSync(site.root, { recursive: true, force: true });
	}
});

test('law 5: values and keys written as the worst text they can be are read back as they were written', async () => {
	const keys = [
		'plain',
		'two words',
		'quote"d',
		"it's",
		'back`tick',
		'${key}',
		'*/',
		'a.b',
		'a-b',
		'日本語',
		'---',
		'constructor',
		'toString',
		'-dash',
		'?question',
		':colon',
		'&amp',
		'*star',
		'1',
		'0x1f',
		'null',
	];
	const site = makeSite();
	const opened = open(site);
	try {
		// every kind of source: the front matter, a module, a sidecar, and pages.overrides
		const tsx = opened.pages().pages.find((p) => p.extension === '.tsx').url;
		const targets = ['/about/', tsx, '/', '/ext/'];
		for (const target of targets) {
			const fresh = opened.pages();
			const page = fresh.pages.find((p) => p.url === target);
			assert.ok(page, target);
			// every value goes to every key, a round at a time
			for (let round = 0; round < HOSTILE_VALUES.length; round += 1) {
				const now = opened.pages().pages.find((p) => p.url === target);
				const meta = { ...now.meta };
				for (const [i, key] of keys.entries()) {
					meta[key] = HOSTILE_VALUES[(i + round) % HOSTILE_VALUES.length];
				}
				const rows = given(opened.pages()).map((entry) =>
					entry.url === target ? { ...entry, meta } : entry,
				);
				const prepared = await prepare(opened, site, scriptReturning(site, rows));
				assert.equal(
					prepared.kind === 'nochange' || prepared.kind === 'review',
					true,
					`${target} round ${round}: ${prepared.kind} ${JSON.stringify(prepared.problems ?? prepared.message)}`,
				);
				if (prepared.kind === 'review') {
					const applied = prepared.apply();
					assert.equal(
						applied.ok,
						true,
						`${target} round ${round}: ${JSON.stringify(applied)}`,
					);
				}
				const read = open(site);
				try {
					assert.deepEqual(
						read.pages().pages.find((p) => p.url === target).meta,
						meta,
						`${target} round ${round}`,
					);
				} finally {
					read.close();
				}
			}
		}
	} finally {
		opened.close();
		rmSync(site.root, { recursive: true, force: true });
	}
});

test('law 5: the key __proto__ is written as a key in a front matter and in pages.overrides, and refused in a module, with nothing written', async () => {
	const site = makeSite();
	const opened = open(site);
	try {
		const tsx = opened.pages().pages.find((p) => p.extension === '.tsx').url;
		// what each kind of source does with it: an object literal of a module cannot have the key
		// (it sets the prototype), a front matter and an entry of pages.overrides can
		const written = new Set(['/about/', '/ext/']);
		for (const target of ['/about/', tsx, '/ext/']) {
			const fresh = opened.pages();
			const page = fresh.pages.find((p) => p.url === target);
			const meta = JSON.parse(
				`{${[
					...Object.entries(page.meta).map(
						([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`,
					),
					'"__proto__":{"polluted":true}',
				].join(',')}}`,
			);
			const rows = given(fresh).map((entry) =>
				entry.url === target ? { ...entry, meta } : entry,
			);
			const file = path.join(scriptsDir, `proto-${scriptCount++}.mjs`);
			writeFileSync(
				file,
				`export default async () => JSON.parse(${JSON.stringify(JSON.stringify(rows))});`,
			);
			const before = tree(site.root);
			const prepared = await prepare(opened, site, file);
			assert.equal(prepared.kind, 'review', target);
			const applied = prepared.apply();
			if (written.has(target)) {
				assert.equal(applied.ok, true, `${target}: ${JSON.stringify(applied)}`);
				const read = open(site);
				try {
					const back = read.pages().pages.find((p) => p.url === target).meta;
					assert.equal(Object.getPrototypeOf(back), Object.prototype);
					assert.deepEqual(Object.keys(back).toSorted(), Object.keys(meta).toSorted());
					assert.deepEqual(structuredClone(back.__proto__), { polluted: true });
				} finally {
					read.close();
				}
			} else {
				assert.equal(applied.ok, false, target);
				assert.match(applied.message, /__proto__/u);
				assert.deepEqual(tree(site.root), before);
			}
		}
		assert.equal({}.polluted, undefined);
	} finally {
		opened.close();
		rmSync(site.root, { recursive: true, force: true });
	}
});

test('a page whose url a key decides moves its file and keeps its url, and returned again changes nothing', async () => {
	const site = makeSite({ pages: { outputPathField: 'slug' } });
	site.write('src/keyed.html', '---\ntitle: Keyed\nslug: /keyed/\n---\n<p>k</p>\n');
	const opened = open(site);
	try {
		const snapshot = opened.pages();
		const keyed = snapshot.pages.find((p) => p.url === '/keyed/');
		assert.ok(keyed);
		assert.equal(snapshot.outputPathField, 'slug');
		const rows = given(snapshot).map((entry) =>
			entry.url === '/keyed/' ? { ...entry, inputPath: 'moved/keyed.html' } : entry,
		);
		const file = scriptReturning(site, rows);
		const prepared = await prepare(opened, site, file);
		assert.equal(prepared.kind, 'review');
		assert.deepEqual(
			prepared.summary.changes.map((c) => c.kind),
			['movedFile'],
		);
		assert.equal(prepared.apply().ok, true);
		// the slug goes with the file, and is the same
		const after = opened.pages().pages.find((p) => p.url === '/keyed/');
		assert.ok(after, 'the url is kept');
		assert.equal(path.relative(snapshot.inputDir, after.inputPath), 'moved/keyed.html');
		assert.ok(site.read('src/moved/keyed.html').includes('slug: /keyed/'));
		const last = await prepare(opened, site, file);
		assert.equal(last.kind, 'nochange');
	} finally {
		opened.close();
		rmSync(site.root, { recursive: true, force: true });
	}
});

test('order is a key like the others: the numbers a script returns place the pages, and the same rows returned again change nothing', async () => {
	const site = makeSite();
	const opened = open(site);
	try {
		const snapshot = opened.pages();
		const numbers = { '/service/': -2, '/about/': '5' };
		const rows = given(snapshot).map((entry) =>
			entry.url in numbers
				? { ...entry, meta: { ...entry.meta, order: numbers[entry.url] } }
				: entry,
		);
		const file = scriptReturning(site, rows);
		const prepared = await prepare(opened, site, file);
		assert.equal(prepared.kind, 'review');
		assert.equal(prepared.apply().ok, true);
		const urls = opened.pages().pages.map((page) => page.url);
		// a number below 0 goes before the pages that have none, a number above 0 after them, and
		// the pages below a page go with it
		assert.equal(urls[0], '/');
		assert.equal(urls[1], '/service/');
		assert.equal(urls.at(-2), '/about/');
		assert.equal(urls.at(-1), '/about/history.html');
		// the number is written in the file the page is, and the page is what it was in the rest
		assert.ok(site.read('src/service/index.html').includes('order: -2'));
		assert.ok(site.read('src/about/index.html').includes('order: "5"'));
		const again = await prepare(opened, site, file);
		assert.equal(again.kind, 'nochange');
		// the order of the rows returned does not place a page
		const reversed = await prepare(
			opened,
			site,
			scriptReturning(site, given(opened.pages()).toReversed()),
		);
		assert.equal(reversed.kind, 'nochange');
	} finally {
		opened.close();
		rmSync(site.root, { recursive: true, force: true });
	}
});

test('order is deleted like any key: rows without it take it away, and the pages go back among the others', async () => {
	const site = makeSite();
	const opened = open(site);
	try {
		const place = async (numbers) => {
			const rows = given(opened.pages()).map((entry) =>
				entry.url in numbers
					? { ...entry, meta: { ...entry.meta, order: numbers[entry.url] } }
					: entry,
			);
			const prepared = await prepare(opened, site, scriptReturning(site, rows));
			assert.equal(prepared.kind, 'review');
			assert.equal(prepared.apply().ok, true);
		};
		await place({ '/service/': -2 });
		assert.equal(opened.pages().pages[1].url, '/service/');
		// the rows come back without the key: it goes from the file
		const without = given(opened.pages()).map((entry) => ({
			...entry,
			meta: Object.fromEntries(
				Object.entries(entry.meta).filter(([key]) => key !== 'order'),
			),
		}));
		const prepared = await prepare(opened, site, scriptReturning(site, without));
		assert.equal(prepared.kind, 'review');
		assert.equal(prepared.apply().ok, true);
		assert.ok(!site.read('src/service/index.html').includes('order'));
		const urls = opened.pages().pages.map((page) => page.url);
		assert.notEqual(urls[1], '/service/');
		// a number that is the same number written as a text is another value (as `1` and `"1"`
		// are), and is written; the place is the same
		const numbers = given(opened.pages()).map((entry) =>
			entry.url === '/service/' ? { ...entry, meta: { ...entry.meta, order: 3 } } : entry,
		);
		await prepare(opened, site, scriptReturning(site, numbers)).then((p) => p.apply());
		const before = opened.pages().pages.map((page) => page.url);
		const texts = given(opened.pages()).map((entry) =>
			entry.url === '/service/'
				? { ...entry, meta: { ...entry.meta, order: '3' } }
				: entry,
		);
		const spelled = await prepare(opened, site, scriptReturning(site, texts));
		assert.equal(spelled.kind, 'review');
		assert.equal(spelled.apply().ok, true);
		assert.deepEqual(
			opened.pages().pages.map((page) => page.url),
			before,
		);
	} finally {
		opened.close();
		rmSync(site.root, { recursive: true, force: true });
	}
});
