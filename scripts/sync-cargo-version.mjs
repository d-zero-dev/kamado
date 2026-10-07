/**
 * Keeps the version of the Rust workspace (`Cargo.toml` and `Cargo.lock`) equal to the
 * version in `lerna.json`, which is the version of the published `kamado` package.
 *
 * Why: the addon reports `kd_napi <version>` and the package carries it, so the two
 * must not drift. `scripts/release.mjs` (`yarn release*`) runs this after `lerna version`
 * and puts the changed files into the release commit. The publish workflow runs it with
 * `--check` and stops on a mismatch.
 *
 * Usage: node scripts/sync-cargo-version.mjs [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A package of the lock file that comes from a registry or git has a `source` line right
// after its version. Only workspace members (no `source`) take the workspace version.
const LOCK_VERSION =
	/(\[\[package\]\]\nname = "[^"]+"\nversion = ")[^"]*("\n)(?!source )/g;

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
	const lines = toml.split('\n');
	const table = lines.indexOf('[workspace.package]');
	if (table !== -1) {
		for (let i = table + 1; i < lines.length && !lines[i].startsWith('['); i++) {
			if (/^version\s*=/.test(lines[i])) {
				lines[i] = `version = "${version}"`;
				return lines.join('\n');
			}
		}
	}
	throw new Error('Cargo.toml: [workspace.package] has no `version`');
}

/**
 * Sets the version of every workspace member in a `Cargo.lock`. A package that has a
 * `source` (a registry or git crate) keeps its own version.
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

/**
 * Brings `Cargo.toml` and `Cargo.lock` of a repository to the version of its `lerna.json`.
 * @param {string} root - The repository root
 * @param {{ check: boolean }} options - `check` only reports; otherwise the files are written
 * @returns {{ version: string; stale: string[] }} The lerna version and the files that differed
 * @example
 * syncCargoVersion('/repo', { check: true }); // { version: '3.0.0', stale: [] }
 */
export function syncCargoVersion(root, { check }) {
	const { version } = JSON.parse(readFileSync(path.join(root, 'lerna.json'), 'utf8'));
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
	return { version, stale };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const check = process.argv.includes('--check');
	const { version, stale } = syncCargoVersion(path.resolve(import.meta.dirname, '..'), {
		check,
	});

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
