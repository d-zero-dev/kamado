import { native } from './native.js';

/** Build-time switches; every field is optional and defaults to the config. */
export interface BuildOptions {
	readonly incremental?: boolean;
	readonly force?: boolean;
	readonly skipUnchanged?: boolean;
	/** Globs relative to the input directory; only matching pages are built. */
	readonly targets?: readonly string[];
	readonly jobs?: number;
	readonly cacheDir?: string;
}

export type PageStatus = 'built' | 'cached' | 'unchanged' | 'skipped' | 'virtual';

export interface PageResult {
	readonly url: string;
	readonly inputPath: string;
	readonly outputPath: string;
	readonly status: PageStatus;
	readonly meta: Record<string, unknown>;
}

export interface BuildReport {
	readonly version: 1;
	readonly pages: readonly PageResult[];
	readonly warnings: readonly string[];
	readonly elapsedMs: number;
}

/**
 * Builds the site described by `configPath` (an absolute path to
 * `kamado.config.jsonc`). Errors from the core are thrown as `Error`.
 * @param configPath - Absolute path of the config file
 * @param options - Build switches
 * @returns The build report
 * @example
 * ```ts
 * const report = build('/site/kamado.config.jsonc', { incremental: true });
 * console.log(report.pages.filter((p) => p.status === 'built').length);
 * ```
 */
export function build(configPath: string, options: BuildOptions = {}): BuildReport {
	const json = native().build(configPath, JSON.stringify(options));
	return JSON.parse(json) as BuildReport;
}
