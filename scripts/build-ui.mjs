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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = path.join(root, 'packages', 'kamado', 'client');
const out = path.join(root, 'packages', 'kamado', 'dist', 'ui');

// Only what this script wrote: the compiled server code of the same directory stays.
await rm(path.join(out, 'assets'), { recursive: true, force: true });
await mkdir(path.join(out, 'assets'), { recursive: true });

await build({
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
	logLevel: 'warning',
});
await copyFile(path.join(client, 'index.html'), path.join(out, 'index.html'));
