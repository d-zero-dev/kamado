/**
 * Checks an unpacked `kamado` package: it carries the screen of `kamado ui` (`dist/ui/index.html`
 * and the bundle and style sheet it names), and that screen asks for no file that is not in the
 * package.
 *
 * Why: the screen is built by `yarn build` from `packages/kamado/client`, and `files` of the
 * package takes `dist` whole, so a build that skipped it publishes a `kamado ui` that answers
 * every request with an error, and nothing else fails.
 *
 * Usage: node scripts/check-package-ui.mjs <unpacked package directory>
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The files of the screen, from the package root. */
export const UI_FILES = [
	'dist/ui/index.html',
	'dist/ui/assets/app.js',
	'dist/ui/assets/app.css',
];

/**
 * The licence file the bundle points to, if it does. esbuild (`legalComments: 'linked'`)
 * writes the licences of what is bundled to `app.js.LEGAL.txt` and ends the bundle with a
 * comment naming it; it writes neither when no bundled code has a licence comment. A bundle
 * that names the file must come with it (React asks for its notice to travel with it).
 * @param {string} js - The bundle
 * @returns {string | null} The file, from the package root, or `null` when there is none
 * @example
 * legalFileOf('x;/*! For license information please see app.js.LEGAL.txt *\/');
 * // 'dist/ui/assets/app.js.LEGAL.txt'
 */
export function legalFileOf(js) {
	const named = /see (app\.js\.LEGAL\.txt)/.exec(js);
	return named === null ? null : `dist/ui/assets/${named[1]}`;
}

/** Where the page of the screen has the token, which the server puts in when it serves it. */
export const TOKEN_PLACEHOLDER = '__KAMADO_TOKEN__';

/**
 * Lists what is empty among the files of the screen (a build that wrote nothing).
 * @param {(file: string) => number} sizeOf - The size of a file of the package, in bytes
 * @returns {string[]}
 * @example
 * emptyUiFiles(() => 0); // every file of the screen
 */
export function emptyUiFiles(sizeOf) {
	return UI_FILES.filter((file) => sizeOf(file) === 0);
}

/**
 * Lists the files of the screen that the package lacks.
 * @param {(file: string) => boolean} has - Whether the package has a file (a path from its root)
 * @returns {string[]}
 * @example
 * missingUiFiles((file) => file !== 'dist/ui/index.html'); // ['dist/ui/index.html']
 */
export function missingUiFiles(has) {
	return UI_FILES.filter((file) => !has(file));
}

/**
 * The `/assets/...` files a page asks for (`src` and `href`).
 * @param {string} html - The page
 * @returns {string[]} Paths from the package root
 * @example
 * assetsOf('<script src="/assets/app.js"></script>'); // ['dist/ui/assets/app.js']
 */
export function assetsOf(html) {
	return [...html.matchAll(/(?:src|href)=["']\/(assets\/[^"']+)["']/g)].map(
		(match) => `dist/ui/${match[1]}`,
	);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const dir = process.argv[2];
	if (!dir) {
		console.error('Usage: node scripts/check-package-ui.mjs <package directory>');
		process.exit(2);
	}
	const packageRoot = path.resolve(dir);
	const has = (file) => existsSync(path.join(packageRoot, file));
	const missing = missingUiFiles(has);
	if (missing.length > 0) {
		console.error(`The package lacks the screen of kamado ui: ${missing.join(', ')}`);
		process.exit(1);
	}
	const empty = emptyUiFiles((file) => statSync(path.join(packageRoot, file)).size);
	if (empty.length > 0) {
		console.error(`The screen of kamado ui has empty files: ${empty.join(', ')}`);
		process.exit(1);
	}
	const legal = legalFileOf(
		readFileSync(path.join(packageRoot, 'dist/ui/assets/app.js'), 'utf8'),
	);
	if (legal !== null && !has(legal)) {
		console.error(`The bundle of kamado ui points to ${legal}, which the package lacks`);
		process.exit(1);
	}
	const html = readFileSync(path.join(packageRoot, 'dist/ui/index.html'), 'utf8');
	if (!html.includes(TOKEN_PLACEHOLDER)) {
		console.error(
			`dist/ui/index.html lacks ${TOKEN_PLACEHOLDER}: every write of the screen would be refused`,
		);
		process.exit(1);
	}
	const asked = assetsOf(html).filter((file) => !has(file));
	if (asked.length > 0) {
		console.error(`The screen asks for files the package lacks: ${asked.join(', ')}`);
		process.exit(1);
	}
	console.log(`ok: the screen of kamado ui is in the package (${UI_FILES.length} files)`);
}
