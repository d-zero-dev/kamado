/**
 * Bundles the screen of `kamado ui` (`packages/kamado/client`) into `packages/kamado/dist/ui`:
 * `index.html` and `assets/app.js` + `assets/app.css`, which the server of `kamado ui` serves.
 *
 * React is a devDependency of the package and ends up in the bundle, so that the package's
 * dependencies stay `esbuild` and `hono`. `yarn dev` (`tsc --watch`) does not run this: after
 * a change to the client, run `yarn build`.
 *
 * Usage: node scripts/build-ui.mjs   (from the repository root)
 */
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import { isMain } from './is-main.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = path.join(root, 'packages', 'kamado', 'client');
const out = path.join(root, 'packages', 'kamado', 'dist', 'ui');

/**
 * The options the screen is bundled with.
 * @returns {import('esbuild').BuildOptions} What `build` of esbuild is called with
 * @example
 * await build(bundleOptions());
 */
export function bundleOptions() {
	return {
		entryPoints: { app: path.join(client, 'src', 'main.tsx') },
		outdir: path.join(out, 'assets'),
		bundle: true,
		format: 'esm',
		jsx: 'automatic',
		minify: true,
		sourcemap: false,
		legalComments: 'linked',
		target: 'es2023',
		define: { 'process.env.NODE_ENV': '"production"' },
		// The tsconfig of the screen, named and not looked for: esbuild otherwise reads every
		// `tsconfig.json` on the way up to the root of the file system, and one of a directory
		// above the repository (a checkout this one is a worktree of) is not ours to be warned
		// about.
		tsconfig: path.join(client, 'tsconfig.json'),
		logLevel: 'warning',
	};
}

if (isMain(import.meta.filename)) {
	// Only what this script wrote: the compiled server code of the same directory stays.
	await rm(path.join(out, 'assets'), { recursive: true, force: true });
	await mkdir(path.join(out, 'assets'), { recursive: true });
	await build(bundleOptions());
	await copyFile(path.join(client, 'index.html'), path.join(out, 'index.html'));
}
