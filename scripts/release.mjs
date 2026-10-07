/**
 * Runs `lerna version` and brings the Cargo version to the released version.
 *
 * Why not a lifecycle script: lerna reads `enableScripts: false` of `.yarnrc.yml` (the
 * supply-chain guard against install scripts) as "ignore scripts" and skips the `version`
 * lifecycle of the root package, so a hook there never runs. Loosening that guard for
 * a version bump is the wrong trade, so the Cargo files are updated after lerna finished.
 *
 * What it does: lerna makes the release commit and its tag, which are local until pushed.
 * This script writes the version into Cargo.toml and Cargo.lock, adds them to that commit
 * (`git commit --amend`) and moves the tag to the amended commit. It changes nothing when
 * HEAD is not the release commit that lerna just made (for example `--no-git-tag-version`,
 * or no changed package), and then says so.
 *
 * Usage: node scripts/release.mjs <arguments of lerna version>
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { syncCargoVersion } from './sync-cargo-version.mjs';

/**
 * The subject of the commit that `lerna version` makes (`command.version.message` of
 * `lerna.json`; `%s` is the tag name).
 * @param {string} version - The released version
 * @returns {string}
 * @example
 * releaseSubject('3.0.0-alpha.1'); // 'chore(release): publish v3.0.0-alpha.1'
 */
export function releaseSubject(version) {
	return `chore(release): publish v${version}`;
}

/**
 * Whether HEAD is the release commit of a version: it has the subject lerna gives and the
 * tag of the version points at it.
 * @param {{ subject: string; head: string; tagTarget: string | undefined; version: string }} state - HEAD's subject and hash, the commit the version's tag points at, and the version
 * @returns {boolean}
 * @example
 * isReleaseCommit({
 * 	subject: 'chore(release): publish v1.0.0',
 * 	head: 'abc',
 * 	tagTarget: 'abc',
 * 	version: '1.0.0',
 * }); // true
 */
export function isReleaseCommit({ subject, head, tagTarget, version }) {
	return subject === releaseSubject(version) && tagTarget === head;
}

/**
 * Runs git in the repository root and returns the trimmed output.
 * @param {string} root - The repository root
 * @param {string[]} args - Arguments of git
 * @returns {string}
 */
function git(root, args) {
	const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
	}
	return result.stdout.trim();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const root = path.resolve(import.meta.dirname, '..');

	const lerna = spawnSync('yarn', ['lerna', 'version', ...process.argv.slice(2)], {
		cwd: root,
		stdio: 'inherit',
	});
	if (lerna.status !== 0) {
		process.exit(lerna.status ?? 1);
	}

	const { version, stale } = syncCargoVersion(root, { check: true });
	if (stale.length === 0) {
		console.log(`Cargo version is already ${version}`);
	} else {
		let tagTarget;
		try {
			tagTarget = git(root, ['rev-parse', `v${version}^{commit}`]);
		} catch {
			// No tag of this version: lerna did not release.
		}
		const state = {
			subject: git(root, ['log', '-1', '--format=%s']),
			head: git(root, ['rev-parse', 'HEAD']),
			tagTarget,
			version,
		};
		if (!isReleaseCommit(state)) {
			console.error(
				`HEAD is not the release commit of v${version}, so the Cargo files were not changed.` +
					' Run node scripts/sync-cargo-version.mjs and commit them yourself.',
			);
			process.exit(1);
		}
		syncCargoVersion(root, { check: false });
		git(root, ['add', 'Cargo.toml', 'Cargo.lock']);
		git(root, ['commit', '--amend', '--no-edit']);
		git(root, ['tag', '-f', '-a', `v${version}`, '-m', `v${version}`]);
		console.log(
			`Cargo version set to ${version} in the release commit; tag v${version} moved to it`,
		);
	}
}
