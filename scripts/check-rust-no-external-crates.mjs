/**
 * Fails when the Rust workspace depends on any crate that is not a workspace member.
 *
 * Why: the Rust side is dependency-free on purpose (supply-chain safety). A
 * package fetched from a registry or git has a non-null `source` in
 * `cargo metadata`; workspace members and path dependencies have `null`.
 *
 * Usage: node scripts/check-rust-no-external-crates.mjs
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Picks the packages that come from a registry or git instead of the workspace.
 * @param {{ packages: { name: string; version: string; source: string | null }[] }} metadata - Output of `cargo metadata`
 * @returns {{ name: string; version: string; source: string | null }[]}
 * @example
 * findExternalCrates({ packages: [{ name: 'a', version: '1.0.0', source: null }] }); // []
 */
export function findExternalCrates(metadata) {
	return metadata.packages.filter((pkg) => pkg.source !== null);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const metadata = JSON.parse(
		execFileSync(
			'cargo',
			['metadata', '--locked', '--offline', '--format-version', '1'],
			{
				encoding: 'utf8',
				maxBuffer: 64 * 1024 * 1024,
			},
		),
	);
	const external = findExternalCrates(metadata);

	if (external.length > 0) {
		console.error('External crates found (the Rust workspace must have none):');
		for (const pkg of external) {
			console.error(`  ${pkg.name}@${pkg.version} (${pkg.source})`);
		}
		process.exitCode = 1;
	} else {
		console.log(`ok: ${metadata.packages.length} workspace crates, 0 external crates`);
	}
}
