/**
 * Loads the Rust core (a Node-API addon).
 *
 * Resolution order: `KAMADO_NATIVE_ADDON` (an explicit file, for development), then the
 * addon of this platform that the package carries (`native/<os>-<arch>/kd_napi.node`, every
 * supported platform is bundled in the one package), then the workspace build output
 * (`target/release`, then `target/debug`) relative to this package. `process.dlopen` loads a
 * shared library of any file name, so the Cargo artifact is used as is, without copying it
 * to `.node`.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Native {
	/** `kd_napi <version>` */
	version(): string;
	/** Hex SHA-256 of a Buffer, used by the load check. */
	sha256Hex(buffer: Buffer): string;
	/** Runs a build; `optionsJson` is a `BuildOptions` object, the result is a report. */
	build(configPath: string, optionsJson: string): string;
	/**
	 * Plans the pages without rendering them; the result is the JSON list of
	 * the pages (see `PageMap` in `pages.ts`). `optionsJson` takes
	 * `incremental` and `cacheDir`.
	 */
	pages(configPath: string, optionsJson: string): string;
	/**
	 * Plans a build and compiles the JSX modules. The result is JSON:
	 * `{ handle, jobs, context, scripts }` (see `Prepared` in `build.ts`).
	 */
	prepare(configPath: string, optionsJson: string, runtimeUrl: string): string;
	/**
	 * Compiles the data files that are scripts (`.ts`, `.mts`, `.js`, `.mjs` in `data.dir`)
	 * for Node to run before `prepare`. The result is JSON: `{ cacheDir, dataDir, modules:
	 * [{ key, source, module, sources }] }` (see `DataPlan` in `data-files.ts`). `optionsJson`
	 * takes `cacheDir`.
	 */
	dataPlan(configPath: string, optionsJson: string, runtimeUrl: string): string;
	/**
	 * Finishes a prepared build with `{ pages: [[page, html], ...], scripts:
	 * [{ id, code, inputs }, ...] }`; the result is a report.
	 */
	finish(handle: string, resultsJson: string): string;
	/**
	 * Hands over rendered HTML before `finish`, as frames of a little-endian
	 * `u32` page index, a `u32` byte length and the UTF-8 bytes.
	 */
	feed(handle: string, frames: Buffer): void;
	/** Forgets a prepared build that will not be finished. */
	abort(handle: string): void;
	/**
	 * Opens the dev server of a project. The result is JSON: `{ handle,
	 * devServer, inputDir, outputDir, siteName }` (see `ServeDescription`).
	 */
	serveOpen(configPath: string, optionsJson: string, runtimeUrl: string): string;
	/**
	 * Answers a request for a path; the result is JSON (see `Answer`).
	 * `rendererStarted` is `"0"` when the caller lost the renderer, so the
	 * core sends the whole context again.
	 */
	serveRequest(handle: string, urlPath: string, rendererStarted: '1' | '0'): string;
	/** Takes the HTML rendered for a `render` answer; the result is JSON. */
	serveFinishRender(handle: string, token: string, html: string): string;
	/** `serveFinishRender` with the keys of `data` the page read, as a JSON array. */
	serveFinishRenderReads(
		handle: string,
		token: string,
		html: string,
		readsJson: string,
	): string;
	/**
	 * Gives the dev server what the data files that are scripts made of themselves, for all
	 * of them: `{ <key>: { value } | { error } }`.
	 */
	serveSetData(handle: string, executedJson: string): string;
	/** Takes what esbuild built for a `script` answer; the result is JSON. */
	serveFinishScript(handle: string, token: string, outputJson: string): string;
	serveCancel(handle: string, token: string): string;
	/** Forgets a dev server. */
	serveClose(handle: string): void;
	/**
	 * Plans the site and keeps the editor of its pages (RFC §14.2); the result is its
	 * handle. `optionsJson` takes `incremental` and `cacheDir`.
	 */
	uiOpen(configPath: string, optionsJson: string): string;
	/**
	 * A page of rows: `queryJson` is `{ offset, limit, q?, sort? }`; the result is JSON
	 * (`version`, `total`, `columns`, `layouts`, `keys`, `overridesHash`, `pages`, `warnings`).
	 * `layouts` is the names of the files in `pages.layouts.dir` (`null` when that is not set,
	 * `[]` when the directory is not there), as read when the handle was opened or refreshed.
	 */
	uiPages(handle: string, queryJson: string): string;
	/**
	 * The values a metadata key has over every page: `queryJson` is `{ key: 'meta:<key>', limit }`;
	 * the result is JSON (`version`, `key`, `total`, `values: [{ value, count }]`, most often
	 * first). A request that is not one throws.
	 */
	uiValues(handle: string, queryJson: string): string;
	/**
	 * Plans the site again and reads `pages.layouts.dir` again; the result is `{ version }`. A
	 * layouts directory that cannot be read throws, and the handle stays as it was.
	 */
	uiRefresh(handle: string): string;
	/**
	 * Makes one edit (`{ url, expect, change }`, where `change.op` is `set`, `delete`, `moveUrl`,
	 * `movePath` or `revert`; `movePath` carries `path`, relative to `dir.input`, and `revert` the `key`
	 * and what a commit holds of the files, as `uiDiff` is told it); the result is JSON,
	 * `{ ok: true, ... }` or `{ ok: false, code, message, current? }`. A move removes the
	 * directories it leaves empty. A request that is not one throws.
	 */
	uiEdit(handle: string, editJson: string): string;
	/**
	 * Makes several edits as one: all of them, or none (`{ edits: [{ url, expect, change }, …] }`;
	 * each edit is the request of `uiEdit` (`set`, `delete`, `moveUrl`, `movePath`, `create`,
	 * `virtualize`, `materialize`, `deletePage`), but `revert` is not taken). The order of `edits` does
	 * not decide the order they are made in: what frees places comes first, then the moves (in an
	 * order that finds each place free, exchanges and rings included), then what makes pages, then
	 * the keys. Every edit names the page as it is before the batch. Every `expect` is checked,
	 * against the files before the batch, before anything is written; if any edit then fails,
	 * everything written is put back.
	 *
	 * The result is JSON: `{ ok: true, version, overridesHash, count, warning? }` (`version` is one
	 * more than before), or `{ ok: false, code, message, errors: [{ index, code, message }] }` with
	 * nothing written and the version as it was. `errors` has every edit that cannot be made with
	 * the others (told before anything is written), or the one edit that was refused while the batch
	 * was made; `index` is `null` for a failure no edit is behind. A request that is not one throws.
	 */
	uiEditBatch(handle: string, batchJson: string): string;
	/**
	 * The git blob ids of what the files of some pages hold now (`{ urls, format }`, where `format`
	 * is `sha1` or `sha256`); the result is JSON, `{ files: [{ path, blob }], overrides }`. A URL no
	 * page has is skipped. The core runs no `git`: the caller compares these with the ids git has.
	 */
	uiDiffFiles(handle: string, queryJson: string): string;
	/**
	 * The difference of some pages from a commit (`{ urls, format, head }`, where `head` says what the
	 * commit holds of each file `uiDiffFiles` listed); the result is JSON, `{ version, pages, columns }`,
	 * or `{ need: [path, …] }` when the text of files of the commit has to be given.
	 */
	uiDiff(handle: string, queryJson: string): string;
	/**
	 * Every page, for a sync (RFC §14.2): the result is JSON, `{ version, overridesHash, inputDir,
	 * overridesFile, outputPathField, warnings, pages }` (`overridesFile` is the absolute path of
	 * `pages.overrides`, or `null`). Each page is the entry of `kamado pages` (RFC §14.1, with
	 * absolute paths) plus `hashes` (`{ input, sidecar }`, the hashes of its files as `uiPages` gives
	 * them). `outputPathField` is the key that decides the URL, or `null`.
	 */
	uiSyncPages(handle: string): string;
	/**
	 * The keys that cannot be edited, for some pages (`{ urls }`), for a sync: the result is JSON,
	 * `{ version, locked: { <url>: { <key>: <why> } } }`, with an entry for each URL a page has. Apart
	 * from `uiSyncPages` because telling it reads and parses the page file, which is most of the time
	 * of listing 100,000 pages; a sync asks only for the pages whose keys it would change.
	 */
	uiSyncLocked(handle: string, queryJson: string): string;
	/**
	 * What the config says that the command serving the editor needs: the result is
	 * `{ port, open, inputDir, outputDir, overrides, syncFunctions, defaultKeyOrder, defaultFixedKeys }`
	 * (`devServer.port`, `devServer.open`, `dir.*`, the absolute path of `pages.overrides` or `null`, the
	 * operations of `ui.syncFunctions`, each `{ name, label, script }` with the label as written and the
	 * script absolute, and `ui.defaultKeyOrder` and `ui.defaultFixedKeys` as arrays of column identifiers
	 * as written, or `null` when the config does not write them).
	 */
	uiServer(handle: string): string;
	/** Forgets an editor; the result is `{ warning }`. */
	uiClose(handle: string): string;
}

const LIBRARY_NAME = process.platform === 'darwin' ? 'libkd_napi.dylib' : 'libkd_napi.so';

/**
 * Where the package carries the addon of a platform: `native/<os>-<arch>/kd_napi.node`
 * (the same name on every platform, so that one lookup serves them all).
 * @param packageRoot - The directory of the package (where `package.json` is)
 * @param platform - `process.platform`
 * @param arch - `process.arch`
 * @example
 * ```ts
 * bundledAddon('/app/node_modules/kamado', 'darwin', 'arm64');
 * // '/app/node_modules/kamado/native/darwin-arm64/kd_napi.node'
 * ```
 */
export function bundledAddon(
	packageRoot: string,
	platform: string,
	arch: string,
): string {
	return path.join(packageRoot, 'native', `${platform}-${arch}`, 'kd_napi.node');
}

/**
 * Candidate library files, most specific first.
 */
function candidates(): string[] {
	const list: string[] = [];
	const explicit = process.env.KAMADO_NATIVE_ADDON;
	if (explicit) {
		list.push(explicit);
	}
	const here = path.dirname(fileURLToPath(import.meta.url));
	// dist/native.js → packages/kamado
	const packageRoot = path.resolve(here, '..');
	// packages/kamado → repo root
	const repoRoot = path.resolve(packageRoot, '..', '..');
	list.push(
		bundledAddon(packageRoot, process.platform, process.arch),
		path.join(repoRoot, 'target', 'release', LIBRARY_NAME),
		path.join(repoRoot, 'target', 'debug', LIBRARY_NAME),
	);
	return list;
}

let loaded: Native | undefined;

/**
 * Returns the addon, loading it on first use.
 * @throws {Error} when no candidate file exists or the library fails to load
 * @example
 * ```ts
 * const core = native();
 * console.log(core.version());
 * ```
 */
export function native(): Native {
	if (loaded) {
		return loaded;
	}
	const tried = candidates();
	const file = tried.find((p) => existsSync(p));
	if (!file) {
		throw new Error(
			`kamado: native core not found. Build it with \`cargo build --release -p kd_napi\` or set KAMADO_NATIVE_ADDON. Tried:\n  ${tried.join('\n  ')}`,
		);
	}
	const mod: { exports: Partial<Native> } = { exports: {} };
	process.dlopen(mod, file);
	loaded = mod.exports as Native;
	return loaded;
}
