/**
 * Keeps the version of the Rust workspace (`Cargo.toml` and `Cargo.lock`) equal to the
 * version in `lerna.json`, which is the version of the published `kamado` package.
 *
 * Why: the addon reports `kd_napi <version>` and the package carries it, so the two
 * must not drift. `lerna version` runs this through the `version` lifecycle script of the
 * root `package.json` and includes the changed files in the release commit. The
 * publish workflow runs it with `--check` and stops on a mismatch.
 *
 * Usage: node scripts/sync-cargo-version.mjs [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKSPACE_VERSION = /^(\[workspace\.package\][^[]*?\nversion = ")[^"]*(")/m;
const LOCK_VERSION = /(\[\[package\]\]\nname = "[^"]+"\nversion = ")[^"]*(")/g;

/**
 * Sets `version` in the `[workspace.package]` table of a `Cargo.toml`.
 * @param {string} toml - Content of the workspace `Cargo.toml`
 * @param {string} version - The version to set
 * @returns {string}
 * @throws {Error} when the table has no `version`
 * @example
 * setWorkspaceVersion('[workspace.package]\nversion = "0.0.0"\n', '1.2.3');
 * // '[workspace.package]\nversion = "1.2.3"\n'
 */
export function setWorkspaceVersion(toml, version) {
	if (!WORKSPACE_VERSION.test(toml)) {
		throw new Error('Cargo.toml: [workspace.package] has no `version`');
	}
	return toml.replace(WORKSPACE_VERSION, `$1${version}$2`);
}

/**
 * Sets the version of every package in a `Cargo.lock`. Every package of the lock file is
 * a workspace member, because the workspace has no external crates.
 * @param {string} lock - Content of `Cargo.lock`
 * @param {string} version - The version to set
 * @returns {string}
 * @example
 * setLockVersions('[[package]]\nname = "kd_hash"\nversion = "0.0.0"\n', '1.2.3');
 * // '[[package]]\nname = "kd_hash"\nversion = "1.2.3"\n'
 */
export function setLockVersions(lock, version) {
	return lock.replaceAll(LOCK_VERSION, `$1${version}$2`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const root = path.resolve(import.meta.dirname, '..');
	const { version } = JSON.parse(readFileSync(path.join(root, 'lerna.json'), 'utf8'));
	const check = process.argv.includes('--check');

	const files = [
		['Cargo.toml', (text) => setWorkspaceVersion(text, version)],
		['Cargo.lock', (text) => setLockVersions(text, version)],
	];
	const stale = [];
	for (const [name, update] of files) {
		const file = path.join(root, name);
		const before = readFileSync(file, 'utf8');
		const after = update(before);
		if (before === after) {
			continue;
		}
		stale.push(name);
		if (!check) {
			writeFileSync(file, after);
		}
	}

	if (check && stale.length > 0) {
		console.error(
			`${stale.join(', ')}: version differs from lerna.json (${version}). Run: node scripts/sync-cargo-version.mjs`,
		);
		process.exitCode = 1;
	} else {
		console.log(
			check ? `ok: Cargo version is ${version}` : `Cargo version set to ${version}`,
		);
	}
}
