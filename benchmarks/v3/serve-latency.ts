/**
 * Latency of the dev server's requests on a fixture site: a page that is built and kept
 * (a hit), a URL that could be a page and is not in the plan, a `/favicon.ico`, and the
 * requests that make the server plan again (RFC §12). It shows that the requests that do
 * not plan cost what they cost without the re-planning, and what one plan costs.
 *
 * Usage: node benchmarks/v3/serve-latency.ts [--pages=1000] [--requests=200] [--port=39400] [--out=dir] [--keep]
 *
 * `--pages` is the size of the fixture site, `--requests` how many times each ordinary request
 * is made, `--port` the port of the server. The fixture goes to `--out` and stays there; with
 * no `--out` it is in a temporary directory that is removed at the end, unless `--keep`.
 *
 * Needs `yarn build` and `cargo build --release -p kd_napi`. `KAMADO_NATIVE_ADDON=<path>`
 * measures another build of the addon (the one before a change, to compare with). With
 * `KD_TIMING=1` the core prints a line for each plan (`replan (walk)` or `replan
 * (assemble)`, with the page count and the time): count them to see how often it planned.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { start } from '../../packages/kamado/dist/index.js';

import { generateJsxFixtures } from './generate-jsx-fixtures.ts';

const { values } = parseArgs({
	options: {
		pages: { type: 'string', default: '1000' },
		requests: { type: 'string', default: '200' },
		port: { type: 'string', default: '39400' },
		out: { type: 'string' },
		keep: { type: 'boolean', default: false },
	},
});
const pages = Number(values.pages);
const requests = Number(values.requests);
const port = Number(values.port);
const outDir = values.out ?? mkdtempSync(path.join(tmpdir(), 'kd-serve-latency-'));

generateJsxFixtures({ pages, seed: 1, outDir, target: 'v3' });
const configPath = path.join(outDir, 'kamado.serve.config.jsonc');
writeFileSync(
	configPath,
	`{
	"dir": { "input": "input", "output": "output" },
	"site": { "siteName": "Bench" },
	"pages": { "files": "pages/**/*.tsx", "layouts": { "dir": "input/_libs/layouts" }, "overrides": "pages.overrides.json" },
	"data": { "dir": "input/_libs/data" },
	"build": { "cacheDir": ".cache" },
	"devServer": { "port": ${port}, "open": false }
}
`,
);
const overridesPath = path.join(outDir, 'pages.overrides.json');
writeFileSync(overridesPath, '{ "version": 1, "pages": [] }\n');

const base = `http://localhost:${port}`;
const firstId = '0'.padStart(String(pages - 1).length, '0');
const hitUrl = `/pages/section-0/page-${firstId}.html`;

/**
 * Asks for a URL and reads the whole answer.
 * @param pathname - The path to ask for
 * @returns the status and how long it took, in milliseconds
 */
async function ask(pathname: string): Promise<{ status: number; ms: number }> {
	const began = performance.now();
	const response = await fetch(base + pathname);
	await response.arrayBuffer();
	return { status: response.status, ms: performance.now() - began };
}

/**
 * Asks for a URL `count` times in a row.
 * @param pathname - The path to ask for
 * @param status - The status every answer must have
 * @param count - How many times
 * @returns the times, in milliseconds, in order
 */
async function askMany(
	pathname: string,
	status: number,
	count: number,
): Promise<number[]> {
	const times: number[] = [];
	for (let i = 0; i < count; i++) {
		const answer = await ask(pathname);
		if (answer.status !== status) {
			throw new Error(`${pathname}: expected ${status}, got ${answer.status}`);
		}
		times.push(answer.ms);
	}
	return times;
}

/**
 * A percentile of a list of times.
 * @param times - The times
 * @param p - The percentile, 0 to 1
 * @returns the time at that percentile
 */
function percentile(times: readonly number[], p: number): number {
	const sorted = times.toSorted((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fixed = (ms: number) => ms.toFixed(2);

// A directory changed a moment before the server opens is taken as changed after its plan
// (the grain of the modification times), and the first page-like miss would plan again.
await wait(300);
const server = await start(configPath, { write: () => {} });
try {
	const first = await ask(hitUrl);
	if (first.status !== 200) {
		throw new Error(`${hitUrl}: expected 200, got ${first.status}`);
	}
	const rows: [string, number[]][] = [
		['hit (a page that is kept)', await askMany(hitUrl, 200, requests)],
		[
			'miss, page-like (no change)',
			await askMany('/pages/section-0/none.html', 404, requests),
		],
		['miss, /favicon.ico', await askMany('/favicon.ico', 404, requests)],
	];
	console.log(`pages: ${pages}, requests: ${requests} each`);
	console.log('| request                     | p50 ms | p99 ms |');
	console.log('| --------------------------- | ------ | ------ |');
	for (const [name, times] of rows) {
		console.log(
			`| ${name.padEnd(27)} | ${fixed(percentile(times, 0.5)).padStart(6)} | ${fixed(percentile(times, 0.99)).padStart(6)} |`,
		);
	}

	// The requests that plan again, once each: the time is the request's (the plan, and the
	// page built again with the whole context given to a new renderer).
	console.log('\n| a request that plans again  | ms     |');
	console.log('| --------------------------- | ------ |');
	const once = async (name: string, pathname: string, status: number) => {
		const answer = await ask(pathname);
		// Not an error: a build of the addon without the re-planning answers 404 here, and
		// the table is how it is compared with.
		const note = answer.status === status ? '' : ` (${answer.status}, not ${status})`;
		console.log(`| ${name.padEnd(27)} | ${fixed(answer.ms).padStart(6)} |${note}`);
	};
	await wait(300);
	appendFileSync(overridesPath, '\n');
	await once('pages.overrides changed', hitUrl, 200);
	// The file was written a moment before that plan, so the server reads it once more when
	// it has settled (RFC §12): that request is not what is measured.
	await wait(100);
	await ask(hitUrl);
	await once('  the same page after it', hitUrl, 200);
	await wait(300);
	const newPage = path.join(outDir, 'input', 'pages', 'section-0', 'new-page.tsx');
	mkdirSync(path.dirname(newPage), { recursive: true });
	writeFileSync(newPage, 'export default () => <p>new</p>;\n');
	await once('a page file was added', '/pages/section-0/new-page.html', 200);
	await wait(300);
	rmSync(newPage);
	await once('a page file was removed', '/pages/section-0/new-page.html', 404);
} finally {
	await server.close();
	if (!values.keep && values.out === undefined) {
		rmSync(outDir, { recursive: true, force: true });
	}
}
