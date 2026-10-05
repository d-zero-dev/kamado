/**
 * Loads the Rust core (a Node-API addon).
 *
 * Resolution order: `KAMADO_NATIVE_ADDON` (an explicit file), then the
 * workspace build output (`target/release`, then `target/debug`) relative
 * to this package. Platform packages that ship the prebuilt library are
 * looked up last. `process.dlopen` loads a shared library of any file name,
 * so the Cargo artifact is used as is, without copying it to `.node`.
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
	 * Plans a build and compiles the JSX modules. The result is JSON:
	 * `{ handle, jobs, context, scripts }` (see `Prepared` in `build.ts`).
	 */
	prepare(configPath: string, optionsJson: string, runtimeUrl: string): string;
	/**
	 * Finishes a prepared build with `{ pages: [[page, html], ...], scripts:
	 * [{ id, code, inputs }, ...] }`; the result is a report.
	 */
	finish(handle: string, resultsJson: string): string;
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
	serveRequest(handle: string, urlPath: string, rendererStarted: "1" | "0"): string;
	/** Takes the HTML rendered for a `render` answer; the result is JSON. */
	serveFinishRender(handle: string, token: string, html: string): string;
	/** Takes what esbuild built for a `script` answer; the result is JSON. */
	serveFinishScript(handle: string, token: string, outputJson: string): string;
	/** Forgets a dev server. */
	serveClose(handle: string): void;
}

const LIBRARY_NAME = process.platform === 'darwin' ? 'libkd_napi.dylib' : 'libkd_napi.so';

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
	// dist/native.js → packages/kamado-v3 → repo root
	const repoRoot = path.resolve(here, '..', '..', '..');
	list.push(
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
	process.dlopen(mod as NodeJS.Module, file);
	loaded = mod.exports as Native;
	return loaded;
}
