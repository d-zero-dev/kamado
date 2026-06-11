import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { describe, test, expect, beforeAll, afterAll } from 'vitest';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, '..', 'dist', 'cli.js');

let tmpDir: string;
let configPath: string;
let outputFile: string;

/**
 * Runs the built CLI in the fixture directory
 * @param args
 */
async function runCli(args: readonly string[]) {
	return await execFileAsync(process.execPath, [cliPath, ...args], {
		cwd: tmpDir,
	});
}

beforeAll(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kamado-cli-'));
	configPath = path.join(tmpDir, 'kamado.config.mjs');
	outputFile = path.join(tmpDir, 'output', 'index.html');

	await fs.writeFile(
		path.join(tmpDir, 'package.json'),
		JSON.stringify({ name: 'cli-fixture', version: '0.0.0', type: 'module' }),
	);
	await fs.writeFile(
		configPath,
		[
			'export default {',
			"\tdir: { input: './input', output: './output' },",
			'\tcompilers: () => [',
			'\t\t{',
			"\t\t\tfiles: '**/*.html',",
			"\t\t\toutputExtension: '.html',",
			"\t\t\tcompiler: () => () => 'page content',",
			'\t\t},',
			'\t],',
			'};',
			'',
		].join('\n'),
	);
	await fs.mkdir(path.join(tmpDir, 'input'), { recursive: true });
	await fs.writeFile(path.join(tmpDir, 'input', 'index.html'), '<p>source</p>');
});

afterAll(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

// E2E test for the built CLI binary — requires `yarn build` to have produced
// dist/cli.js. Skipped on a fresh checkout where dist does not exist yet.
describe.skipIf(!existsSync(cliPath))('kamado build CLI', () => {
	test('--skip-unchanged reaches build(): an unchanged output is not rewritten', async () => {
		await runCli(['build', '--skip-unchanged', '-c', configPath]);
		expect(await fs.readFile(outputFile, 'utf8')).toBe('page content');
		const firstStat = await fs.stat(outputFile);
		const firstMtime = firstStat.mtimeMs;

		await sleep(50);
		await runCli(['build', '--skip-unchanged', '-c', configPath]);

		const secondStat = await fs.stat(outputFile);
		const secondMtime = secondStat.mtimeMs;
		expect(secondMtime).toBe(firstMtime);
	}, 30_000);

	test('without --skip-unchanged the output is rewritten every build', async () => {
		await runCli(['build', '-c', configPath]);
		const firstStat = await fs.stat(outputFile);
		const firstMtime = firstStat.mtimeMs;

		await sleep(50);
		await runCli(['build', '-c', configPath]);

		const secondStat = await fs.stat(outputFile);
		const secondMtime = secondStat.mtimeMs;
		expect(secondMtime).toBeGreaterThan(firstMtime);
	}, 30_000);
});

describe.skipIf(!existsSync(cliPath))('kamado build --incremental', () => {
	let incDir: string;
	let incConfigPath: string;
	let incInputFile: string;
	let incOutputFile: string;
	// In-tree cache dir for the deterministic, auto-cleaned flag-based tests
	let incCacheDir: string;

	beforeAll(async () => {
		incDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kamado-cli-incremental-'));
		incConfigPath = path.join(incDir, 'kamado.config.mjs');
		incInputFile = path.join(incDir, 'input', 'index.html');
		incOutputFile = path.join(incDir, 'output', 'index.html');
		incCacheDir = path.join(incDir, '.cache');

		await fs.writeFile(
			path.join(incDir, 'package.json'),
			JSON.stringify({
				name: 'cli-incremental-fixture',
				version: '0.0.0',
				type: 'module',
			}),
		);
		// The compiler reads the source through kamado's file APIs so the
		// dependency tracker records the input file. The CLI process loads this
		// config, so importing the same dist module yields the same instances
		const filesModuleUrl = pathToFileURL(
			path.resolve(__dirname, '..', 'dist', 'files', 'files.js'),
		).href;
		await fs.writeFile(
			incConfigPath,
			[
				`import { getContentFromFile } from '${filesModuleUrl}';`,
				'',
				'export default {',
				"\tdir: { input: './input', output: './output' },",
				'\tcompilers: () => [',
				'\t\t{',
				"\t\t\tfiles: '**/*.html',",
				"\t\t\toutputExtension: '.html',",
				'\t\t\tcompiler: () => async (file) =>',
				"\t\t\t\t'page:' + (await getContentFromFile(file)).content,",
				'\t\t},',
				'\t],',
				'};',
				'',
			].join('\n'),
		);
		await fs.mkdir(path.join(incDir, 'input'), { recursive: true });
		await fs.writeFile(incInputFile, '<p>v1</p>');
	});

	afterAll(async () => {
		await fs.rm(incDir, { recursive: true, force: true });
	});

	/**
	 * Runs the built CLI build command in the fixture directory
	 * @param args - extra CLI args (the config flag is appended)
	 * @param cwd - working directory to run from
	 */
	async function runBuild(args: readonly string[], cwd = incDir) {
		return await execFileAsync(
			process.execPath,
			[cliPath, 'build', ...args, '-c', incConfigPath],
			{ cwd },
		);
	}

	test('a second --incremental build leaves unchanged outputs untouched', async () => {
		await runBuild(['--incremental', '--cache-dir', incCacheDir]);
		expect(await fs.readFile(incOutputFile, 'utf8')).toBe('page:<p>v1</p>');
		// The manifest lands in the chosen cache directory
		expect(existsSync(path.join(incCacheDir, 'build-manifest.json'))).toBe(true);
		const firstStat = await fs.stat(incOutputFile);

		await sleep(50);
		await runBuild(['--incremental', '--cache-dir', incCacheDir]);

		const secondStat = await fs.stat(incOutputFile);
		expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
	}, 30_000);

	test('an edited source is rebuilt by the next --incremental build', async () => {
		await fs.writeFile(incInputFile, '<p>v2</p>');

		await runBuild(['--incremental', '--cache-dir', incCacheDir]);

		expect(await fs.readFile(incOutputFile, 'utf8')).toBe('page:<p>v2</p>');
	}, 30_000);

	test('--force ignores the cache and rebuilds even when nothing changed', async () => {
		// Seed a fully-cached state
		await runBuild(['--incremental', '--cache-dir', incCacheDir]);
		const firstStat = await fs.stat(incOutputFile);

		await sleep(50);
		// --force rebuilds despite no input change (output is rewritten)
		await runBuild(['--incremental', '--force', '--cache-dir', incCacheDir]);

		const secondStat = await fs.stat(incOutputFile);
		expect(secondStat.mtimeMs).toBeGreaterThan(firstStat.mtimeMs);
	}, 30_000);

	test('by default the cache lives outside the project tree and is keyed by config dir', async () => {
		// Resolve where the default cache goes so the test can clean it up
		const { getCacheDir } = (await import(
			pathToFileURL(path.resolve(__dirname, '..', 'dist', 'builder', 'build-manifest.js'))
				.href
		)) as { getCacheDir: (rootDir: string) => string };
		const defaultCacheDir = getCacheDir(incDir);
		await fs.rm(defaultCacheDir, { recursive: true, force: true });

		const otherCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'kamado-cli-cwd-'));
		try {
			// No --cache-dir: the cache must NOT appear in the project tree
			await runBuild(['--incremental'], otherCwd);
			expect(existsSync(path.join(incDir, '.kamado'))).toBe(false);
			expect(existsSync(path.join(otherCwd, '.kamado'))).toBe(false);
			expect(existsSync(path.join(defaultCacheDir, 'build-manifest.json'))).toBe(true);

			// The cache is keyed by the config directory, not the cwd, so a
			// second run from a different cwd reuses it (output untouched)
			const firstStat = await fs.stat(incOutputFile);
			await sleep(50);
			await runBuild(['--incremental'], incDir);
			const secondStat = await fs.stat(incOutputFile);
			expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
		} finally {
			await fs.rm(otherCwd, { recursive: true, force: true });
			await fs.rm(defaultCacheDir, { recursive: true, force: true });
		}
	}, 30_000);
});
