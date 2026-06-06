import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
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
