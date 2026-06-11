import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Tracks which files a single compilation reads, for the incremental-build
 * manifest.
 *
 * The build loop wraps each file's compilation in {@link collectDependencies};
 * any code running inside that async scope — core file reads via
 * `getFileContent` as well as compilers reporting their own resolved inputs
 * (pug includes, esbuild metafile entries, postcss-import dependencies) via
 * {@link trackDependency} — contributes to that file's dependency set.
 *
 * Outside a collection scope, {@link trackDependency} is a no-op, so regular
 * builds and the dev server pay no cost.
 */

const storage = new AsyncLocalStorage<Set<string>>();

/**
 * Records a file path as a dependency of the compilation currently being
 * collected. No-op when called outside {@link collectDependencies}.
 * @param filePath - Absolute path of the file the compilation depends on
 */
export function trackDependency(filePath: string): void {
	storage.getStore()?.add(filePath);
}

/**
 * Runs a compilation and collects every dependency it reports.
 * @param run - The compilation to run
 * @returns The compilation result and the set of file paths it depends on
 */
export async function collectDependencies<T>(
	run: () => Promise<T>,
): Promise<{ result: T; dependencies: Set<string> }> {
	const dependencies = new Set<string>();
	const result = await storage.run(dependencies, run);
	return { result, dependencies };
}
