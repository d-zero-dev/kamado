import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { missingPlatforms, SUPPORTED_PLATFORMS } from './check-package-addon.mjs';

const SCRIPT = path.join(import.meta.dirname, 'check-package-addon.mjs');

/**
 * An unpacked package whose `dist/native.js` is a stub: `native().version()` answers
 * `reported`, and the bundled addon of each listed platform exists.
 * @param version
 * @param reported
 * @param platforms
 */
function unpacked(version: string, reported: string, platforms: string[]) {
	const root = mkdtempSync(path.join(tmpdir(), 'check-addon-'));
	writeFileSync(path.join(root, 'package.json'), `{ "version": "${version}" }`);
	mkdirSync(path.join(root, 'dist'));
	writeFileSync(
		path.join(root, 'dist', 'native.js'),
		[
			"import path from 'node:path';",
			'export const bundledAddon = (root, os, arch) =>',
			"\tpath.join(root, 'native', `${os}-${arch}`, 'kd_napi.node');",
			`export const native = () => ({ version: () => ${JSON.stringify(reported)} });`,
		].join('\n'),
	);
	for (const platform of platforms) {
		mkdirSync(path.join(root, 'native', platform), { recursive: true });
		writeFileSync(path.join(root, 'native', platform, 'kd_napi.node'), '');
	}
	return root;
}

/**
 * Runs the script on a package directory.
 * @param root
 */
function run(root: string) {
	return spawnSync(process.execPath, [SCRIPT, root], {
		encoding: 'utf8',
		env: { ...process.env, KAMADO_NATIVE_ADDON: '/nonexistent' },
	});
}

describe('missingPlatforms', () => {
	test('nothing is missing when every supported platform is present', () => {
		expect(missingPlatforms(() => true)).toEqual([]);
	});

	test('the platforms without an addon are listed', () => {
		expect(missingPlatforms((platform) => platform !== 'linux-x64')).toEqual([
			'linux-x64',
		]);
	});

	test('every platform is missing when the package has no addon', () => {
		expect(missingPlatforms(() => false)).toEqual(SUPPORTED_PLATFORMS);
	});
});

describe('check-package-addon', () => {
	test('a package with all four addons that reports its own version passes', () => {
		const result = run(
			unpacked('3.0.0-alpha.1', 'kd_napi 3.0.0-alpha.1', [
				'darwin-arm64',
				'darwin-x64',
				'linux-arm64',
				'linux-x64',
			]),
		);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('ok: 4 platforms bundled');
	});

	test('a package without the addon of one platform fails and names it', () => {
		const result = run(
			unpacked('3.0.0-alpha.1', 'kd_napi 3.0.0-alpha.1', [
				'darwin-arm64',
				'darwin-x64',
				'linux-x64',
			]),
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('The package lacks the addon of: linux-arm64');
	});

	test('an addon that reports another version than the package fails', () => {
		const result = run(
			unpacked('3.0.0-alpha.1', 'kd_napi 0.0.0', [
				'darwin-arm64',
				'darwin-x64',
				'linux-arm64',
				'linux-x64',
			]),
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			'The addon reports "kd_napi 0.0.0", the package is "kd_napi 3.0.0-alpha.1"',
		);
	});

	test('a missing directory argument is a usage error', () => {
		const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
		expect(result.status).toBe(2);
		expect(result.stderr).toContain('Usage:');
	});
});
