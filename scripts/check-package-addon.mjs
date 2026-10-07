/**
 * Checks an unpacked `kamado` package: it carries the addon of every supported platform,
 * and the addon of the platform this runs on loads from there and reports the package's
 * version.
 *
 * Why: the package bundles all platforms in one tarball (no per-platform packages), so a
 * missing file or an addon that is not loadable on its own platform is invisible until a
 * user installs it. The publish workflow runs this on every platform before it publishes
 * the very tarball that was checked.
 *
 * Usage: node scripts/check-package-addon.mjs <unpacked package directory>
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** `<os>-<arch>` directories of `native/`. Windows native and musl are not supported. */
export const SUPPORTED_PLATFORMS = [
	'darwin-arm64',
	'darwin-x64',
	'linux-arm64',
	'linux-x64',
];

/**
 * Lists the supported platforms whose addon is missing from the package.
 * @param {(platform: string) => boolean} has - Whether the package has the addon of a platform
 * @returns {string[]}
 * @example
 * missingPlatforms((platform) => platform !== 'linux-x64'); // ['linux-x64']
 */
export function missingPlatforms(has) {
	return SUPPORTED_PLATFORMS.filter((platform) => !has(platform));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const dir = process.argv[2];
	if (!dir) {
		console.error('Usage: node scripts/check-package-addon.mjs <package directory>');
		process.exit(2);
	}
	const packageRoot = path.resolve(dir);
	const { version } = JSON.parse(
		readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
	);
	const { bundledAddon, native } = await import(
		pathToFileURL(path.join(packageRoot, 'dist', 'native.js')).href
	);

	const missing = missingPlatforms((platform) => {
		const [os, arch] = platform.split('-');
		return existsSync(bundledAddon(packageRoot, os, arch));
	});
	if (missing.length > 0) {
		console.error(`The package lacks the addon of: ${missing.join(', ')}`);
		process.exit(1);
	}

	// The same lookup a user's install does. Nothing may redirect it elsewhere, or the
	// check would load a different file than the one in the package.
	delete process.env.KAMADO_NATIVE_ADDON;
	const reported = native().version();
	const expected = `kd_napi ${version}`;
	if (reported !== expected) {
		console.error(`The addon reports "${reported}", the package is "${expected}"`);
		process.exit(1);
	}
	console.log(
		`ok: ${SUPPORTED_PLATFORMS.length} platforms bundled, ${process.platform}-${process.arch} loads (${reported})`,
	);
}
