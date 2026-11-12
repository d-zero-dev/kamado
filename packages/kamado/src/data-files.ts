/**
 * Runs the data files that are scripts (`.ts`, `.mts`, `.js`, `.mjs` in `data.dir`, RFC
 * section 3.2) and keeps what they made, for a build and for the dev server.
 *
 * The core compiles the files and knows what they import (`dataPlan`); this module runs them,
 * each in a worker of its own (see `data-worker.ts`), and hands the values back to the core
 * (`executedData`, `serveSetData`). The core hashes each key, so a page is built again only
 * when a key it read changed (RFC section 11).
 *
 * Why the logs never carry a value: the value is what an API answered, and a URL is often
 * where a token is. They say the file, the key, what was decided, how long it took and the
 * first characters of the hash of the value.
 */
import type { DataWorkerInput, DataWorkerMessage } from './data-worker.js';

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { type FileStamp, stampOf, unchanged } from './data-stamp.js';
import { native } from './native.js';
import { RUNTIME_URL } from './runtime-url.js';

/** A data file that is a script, as the core compiled it. */
export interface DataModule {
	readonly key: string;
	/** The data file (absolute path). */
	readonly source: string;
	/** The compiled module to import (absolute path). */
	readonly module: string;
	/** Every file the module is made of, and the files looked for and not found. */
	readonly sources: readonly string[];
}

/** What the core says about the data files that are scripts. */
export interface DataPlan {
	/** Where the values are kept between runs (absolute path). */
	readonly cacheDir: string;
	/** The data directory (`null` when the site has none). */
	readonly dataDir: string | null;
	/** The extensions (with the dot, in lower case) of the data files that are scripts. */
	readonly extensions: readonly string[];
	readonly modules: readonly DataModule[];
}

/** What the core takes for each key: the value, or why there is none. */
export type ExecutedData = Record<string, { value: unknown } | { error: string }>;

/** The time limit of a data file that declares none, in seconds. */
export const DEFAULT_TIMEOUT_SECONDS = 60;

/** How soon a data file that failed is run again for a request, in milliseconds. */
export const RETRY_AFTER_FAILURE_MS = 5000;

/**
 * Asks the core for the data files that are scripts, compiled.
 * @param configPath - Absolute path of the config file
 * @param cacheDir - The cache directory override, if any
 * @example
 * ```ts
 * const plan = readDataPlan('/site/kamado.config.jsonc', undefined);
 * ```
 */
export function readDataPlan(configPath: string, cacheDir: string | undefined): DataPlan {
	return JSON.parse(
		native().dataPlan(
			configPath,
			JSON.stringify(cacheDir === undefined ? {} : { cacheDir }),
			RUNTIME_URL,
		),
	) as DataPlan;
}

/** What a run came to. */
export type RunOutcome =
	| {
			readonly ok: true;
			readonly value: unknown;
			readonly reads: readonly FileStamp[];
			readonly maxAge: number | null;
	  }
	| {
			readonly ok: false;
			readonly message: string;
			readonly reads: readonly FileStamp[];
	  };

/**
 * Runs one data file in a worker of its own.
 * @param file - The compiled data file
 * @param root - The directory relative paths given to `readFile` are relative to
 * @example
 * ```ts
 * const outcome = await runDataFile(module, '/site');
 * ```
 */
export function runDataFile(file: DataModule, root: string): Promise<RunOutcome> {
	return new Promise((resolve) => {
		const input: DataWorkerInput = {
			module: file.module,
			root,
			defaultTimeoutMs: DEFAULT_TIMEOUT_SECONDS * 1000,
		};
		const worker = new Worker(new URL('data-worker.js', import.meta.url), {
			workerData: input,
		});
		const started = performance.now();
		// What the file read so far, for a run that ends without saying.
		const read = new Map<string, FileStamp>();
		let timer: NodeJS.Timeout | undefined;
		let settled = false;
		const settle = (outcome: RunOutcome) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			void worker.terminate();
			resolve(outcome);
		};
		const limit = (timeoutMs: number) => {
			clearTimeout(timer);
			timer = setTimeout(
				() => {
					settle({
						ok: false,
						message: `it did not finish in ${timeoutMs / 1000} seconds (export const timeout sets the limit)`,
						reads: [...read.values()],
					});
				},
				// The worker aborts the signal at the limit; this is for what ignores it.
				Math.max(0, timeoutMs - (performance.now() - started)) + 1000,
			);
		};
		limit(DEFAULT_TIMEOUT_SECONDS * 1000);
		worker.on('message', (message: DataWorkerMessage) => {
			switch (message.type) {
				case 'limits': {
					limit(message.timeoutMs);
					break;
				}
				case 'read': {
					read.set(message.read.path, message.read);
					break;
				}
				case 'done': {
					settle({
						ok: true,
						value: message.value,
						reads: message.reads,
						maxAge: message.maxAge,
					});
					break;
				}
				case 'failed': {
					settle({ ok: false, message: message.message, reads: message.reads });
					break;
				}
			}
		});
		worker.on('error', (error: Error) => {
			settle({ ok: false, message: error.message, reads: [...read.values()] });
		});
		worker.on('exit', (code) => {
			settle({
				ok: false,
				message: `the worker stopped before it answered (exit code ${code})`,
				reads: [...read.values()],
			});
		});
	});
}

/** What is known of one data file. */
interface State {
	module: DataModule;
	/** The last value, from a run or from the disk. `undefined` when there is none. */
	value: { readonly value: unknown } | undefined;
	/** Why the last run failed. */
	error: string | undefined;
	reads: readonly FileStamp[];
	/** The files the module is made of, as they were when it ran. */
	sources: readonly FileStamp[];
	ranAt: number;
	failedAt: number;
	maxAge: number | null;
}

/** What is written for a key in `<cacheDir>/data/<key>.json`. */
interface CacheEntry {
	readonly version: 1;
	readonly value: unknown;
	readonly reads: readonly FileStamp[];
	readonly sources: readonly FileStamp[];
	readonly ranAt: number;
	readonly maxAge: number | null;
}

/** What a build or a dev server says while it runs the files. */
export interface DataFilesOptions {
	/** The directory `readFile` is relative to: the one with the config file. */
	readonly root: string;
	/**
	 * Asks the core for the plan again, because a file the modules are made of changed or a
	 * file was added. A build plans once and gives none.
	 */
	readonly replan?: () => DataPlan;
	/** A line that is shown only with `--verbose`. */
	readonly verbose?: (line: string) => void;
	/** A line that is always shown. */
	readonly warn?: (line: string) => void;
	/** The clock, for the tests. */
	readonly now?: () => number;
	/** Runs one file, replaceable for the tests (a run is a worker of its own). */
	readonly run?: (file: DataModule, root: string) => Promise<RunOutcome>;
}

/**
 * Maps with at most as many calls at a time as the machine has processors: each run is a
 * thread of its own, and a site with many data files must not start them all together.
 * @param items - What to map
 * @param call - Starts one
 * @returns The results in the order of `items`
 */
async function inParallel<T, R>(
	items: readonly T[],
	call: (item: T) => Promise<R>,
): Promise<R[]> {
	const results: R[] = Array.from({ length: items.length });
	let next = 0;
	const lanes = Array.from(
		{ length: Math.min(items.length, availableParallelism()) },
		async () => {
			while (next < items.length) {
				const at = next++;
				results[at] = await call(items[at]!);
			}
		},
	);
	await Promise.all(lanes);
	return results;
}

/**
 * The first characters of the hash of a value: enough to see that it changed, nothing of what
 * it holds.
 * @param value - A value of a data file
 */
function hashOf(value: unknown): string {
	return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 8);
}

/**
 * Keeps the data files of a site that are scripts, runs them and tells when their values
 * changed.
 * @example
 * ```ts
 * const files = new DataFiles(plan, { root, replan: () => readPlan() });
 * await files.runAll(); // a build
 * const executed = files.executed(); // for the core
 * ```
 */
export class DataFiles {
	/** Set when a run made the core's view of a key differ. */
	#changed = false;
	readonly #options: DataFilesOptions;
	#plan: DataPlan;

	#refreshing: Promise<boolean> | undefined;
	#scriptStamp = '';
	readonly #states = new Map<string, State>();

	constructor(plan: DataPlan, options: DataFilesOptions) {
		this.#plan = plan;
		this.#options = options;
	}

	/**
	 * What to give the core: for each key, the value or why there is none.
	 * @example
	 * ```ts
	 * const options = { executedData: files.executed() };
	 * ```
	 */
	executed(): ExecutedData {
		const out: ExecutedData = {};
		for (const [key, state] of this.#states) {
			if (state.value === undefined) {
				out[key] = {
					error: `${path.basename(state.module.source)}: ${state.error ?? 'it was not run'}`,
				};
			} else {
				out[key] = { value: state.value.value };
			}
		}
		return out;
	}
	/**
	 * Runs again the files that are out of date: one of the files they are made of or read
	 * changed, or they are older than their `maxAge`, or a file was added or removed; a file
	 * that failed is tried again after a few seconds. Requests that ask at the same time wait
	 * for the same run.
	 * @returns whether what the core has to be told changed
	 */
	refresh(): Promise<boolean> {
		const running = this.#refreshing;
		if (running !== undefined) {
			// A request that comes while one is running looks again when it is over: what changed
			// since it began is not seen by it.
			return running.then(async (changed) => (await this.refresh()) || changed);
		}
		const run = this.#refresh().finally(() => {
			this.#refreshing = undefined;
		});
		this.#refreshing = run;
		return run;
	}
	/**
	 * Asks the core for the plan again and runs what is new or changed: the config was
	 * written again (`data.dir`, `pages.alias`), so the plan may differ without a file of the
	 * data directory having changed.
	 */
	async reload(): Promise<void> {
		// A stamp that no directory has: the next refresh plans again.
		this.#scriptStamp = '\0';
		await this.refresh();
	}

	/**
	 * Runs every data file, as a build does, and writes what they made to the disk.
	 * @throws {Error} naming each file that failed and why
	 */
	async runAll(): Promise<void> {
		this.#scriptStamp = await this.#scriptsStamp();
		const outcomes = await inParallel(this.#plan.modules, (module) =>
			this.#run(module, true),
		);
		const failed = outcomes.filter((o): o is string => o !== undefined);
		if (failed.length > 0) {
			throw new Error(`data files failed:\n${failed.map((m) => `  ${m}`).join('\n')}`);
		}
	}

	/**
	 * For the dev server before a request: starts from what the disk holds, so that a
	 * server starts without running the files that did not change and did not age out.
	 * A file that cannot be used from the disk is run; one that fails keeps the disk's old
	 * value when there is one (a warning says so).
	 */
	async start(): Promise<void> {
		this.#scriptStamp = await this.#scriptsStamp();
		await inParallel(this.#plan.modules, async (module) => {
			const cached = await this.#fromDisk(module);
			if (cached !== undefined) {
				this.#states.set(module.key, cached);
				this.#options.verbose?.(
					`data ${module.key}: cache (${this.#age(cached)}, hash ${hashOf(cached.value?.value)})`,
				);
				return;
			}
			await this.#run(module, false);
		});
	}

	#age(state: State): string {
		if (state.maxAge === null) {
			return 'no maxAge';
		}
		const left = Math.max(
			0,
			Math.round(state.maxAge - (this.#now() - state.ranAt) / 1000),
		);
		return `${left}s of maxAge left`;
	}
	#cacheFile(key: string): string {
		return path.join(this.#plan.cacheDir, 'data', `${encodeURIComponent(key)}.json`);
	}
	/**
	 * The state of a file from the disk, when it is still good: nothing it is made of or read changed, and it is not older than its `maxAge`.
	 * @param module - The file
	 */
	async #fromDisk(module: DataModule): Promise<State | undefined> {
		const entry = await this.#readEntry(module);
		if (entry === undefined) {
			return undefined;
		}
		const sources = await this.#stampsOf(module.sources);
		const sameSources =
			entry.sources.length === sources.length &&
			entry.sources.every(
				(s, i) => sources[i]?.path === s.path && sources[i]?.stamp === s.stamp,
			);
		if (!sameSources || !(await unchanged(entry.reads))) {
			return undefined;
		}
		if (entry.maxAge !== null && this.#now() - entry.ranAt >= entry.maxAge * 1000) {
			return undefined;
		}
		return {
			module,
			value: { value: entry.value },
			error: undefined,
			reads: entry.reads,
			sources,
			ranAt: entry.ranAt,
			failedAt: 0,
			maxAge: entry.maxAge,
		};
	}
	#now(): number {
		return (this.#options.now ?? Date.now)();
	}

	/**
	 * The old value of a file that fails, when the disk has one (even if it is out of date).
	 * @param module - The file
	 */
	async #oldFromDisk(
		module: DataModule,
	): Promise<{ readonly value: unknown; readonly maxAge: number | null } | undefined> {
		const entry = await this.#readEntry(module);
		return entry === undefined ? undefined : { value: entry.value, maxAge: entry.maxAge };
	}

	async #readEntry(module: DataModule): Promise<CacheEntry | undefined> {
		try {
			const entry = JSON.parse(
				await readFile(this.#cacheFile(module.key), 'utf8'),
			) as Partial<CacheEntry> | null;
			// A file that is not what this module wrote is not used: the cache is an
			// optimisation that is safe to lose.
			return entry?.version === 1 &&
				'value' in entry &&
				Array.isArray(entry.reads) &&
				Array.isArray(entry.sources) &&
				typeof entry.ranAt === 'number' &&
				(entry.maxAge === null || typeof entry.maxAge === 'number')
				? (entry as CacheEntry)
				: undefined;
		} catch {
			return undefined;
		}
	}
	async #refresh(): Promise<boolean> {
		this.#changed = false;
		const scripts = await this.#scriptsStamp();
		// What each file looks like now, asked once for all the decisions below.
		const looks = new Map<string, { sources: boolean; reads: boolean }>();
		await Promise.all(
			[...this.#states].map(async ([key, state]) => {
				looks.set(key, {
					sources: await unchanged(state.sources),
					reads: await unchanged(state.reads),
				});
			}),
		);
		const moved =
			scripts !== this.#scriptStamp || [...looks.values()].some((look) => !look.sources);
		if (moved) {
			// A file the modules are made of changed, or a data file was added or removed: the
			// core compiles them again and tells what they are made of.
			// The stamp is kept only when the plan was made: a data file that does not compile
			// is looked at again by the next request, and not forgotten.
			try {
				this.#plan = this.#options.replan?.() ?? this.#plan;
			} catch (error) {
				this.#options.warn?.(
					`data files: ${error instanceof Error ? error.message : String(error)}`,
				);
				return false;
			}
			// Of the directory of the plan that was just made, which a config may have changed.
			this.#scriptStamp = await this.#scriptsStamp();
			const keys = new Set(this.#plan.modules.map((m) => m.key));
			for (const key of this.#states.keys()) {
				if (!keys.has(key)) {
					this.#states.delete(key);
					this.#changed = true;
				}
			}
			for (const module of this.#plan.modules) {
				const state = this.#states.get(module.key);
				if (state !== undefined) {
					state.module = module;
				}
			}
		}
		const now = this.#now();
		const due = this.#plan.modules.map((module) => {
			const state = this.#states.get(module.key);
			const look = looks.get(module.key);
			if (state === undefined || look === undefined) {
				return true;
			}
			const changed = !look.sources || !look.reads;
			if (state.error === undefined) {
				return (
					changed || (state.maxAge !== null && now - state.ranAt >= state.maxAge * 1000)
				);
			}
			// A file that failed: tried again when what it is made of or read changed. With no
			// value at all the pages that read it fail, so it is tried again after a few seconds
			// too; with an old value it waits for its `maxAge`, so that a request is not held
			// for a service that does not answer.
			if (state.value === undefined) {
				return changed || now - state.failedAt >= RETRY_AFTER_FAILURE_MS;
			}
			return (
				changed || (state.maxAge !== null && now - state.failedAt >= state.maxAge * 1000)
			);
		});
		await inParallel(
			this.#plan.modules.filter((_, i) => due[i]),
			(m) => this.#run(m, false),
		);
		return this.#changed;
	}

	/**
	 * Runs one file and records what came of it.
	 * @param module - The file
	 * @param strict - A build: a failure is not softened by an old value
	 * @returns the message of the failure, naming the file, or `undefined`
	 */
	async #run(module: DataModule, strict: boolean): Promise<string | undefined> {
		const started = performance.now();
		const before = this.#states.get(module.key);
		const outcome = await (this.#options.run ?? runDataFile)(module, this.#options.root);
		const took = Math.round(performance.now() - started);
		const name = path.basename(module.source);
		if (!outcome.ok) {
			const message = outcome.message.slice(0, 500);
			const disk =
				before?.value === undefined && !strict
					? await this.#oldFromDisk(module)
					: undefined;
			const previous = before?.value ?? (disk && { value: disk.value });
			this.#states.set(module.key, {
				module,
				value: previous,
				error: message,
				reads: outcome.reads,
				sources: await this.#stampsOf(module.sources),
				ranAt: before?.ranAt ?? 0,
				failedAt: this.#now(),
				maxAge: before?.maxAge ?? disk?.maxAge ?? null,
			});
			// The core sees the old value while there is one: a failure that keeps it changes nothing.
			if (
				previous !== before?.value ||
				(previous === undefined && before?.error !== message)
			) {
				this.#changed = true;
			}
			if (!strict) {
				this.#options.warn?.(
					previous === undefined
						? `data ${module.key}: failed (${name}): ${message}`
						: `data ${module.key}: failed (${name}): ${message}; the last value is used`,
				);
			}
			return `${name}: ${message}`;
		}
		const sources = await this.#stampsOf(module.sources);
		const state: State = {
			module,
			value: { value: outcome.value },
			error: undefined,
			reads: outcome.reads,
			sources,
			ranAt: this.#now(),
			failedAt: 0,
			maxAge: outcome.maxAge,
		};
		this.#states.set(module.key, state);
		const hash = hashOf(outcome.value);
		const same = before?.value !== undefined && hashOf(before.value.value) === hash;
		if (!same) {
			this.#changed = true;
		}
		this.#options.verbose?.(
			`data ${module.key}: ran (${took}ms, hash ${hash}${same ? ', unchanged' : ''})`,
		);
		await this.#toDisk(module, state);
		return undefined;
	}
	/** The stamp of the script files of the data directory: what tells a file was added. */
	async #scriptsStamp(): Promise<string> {
		const dir = this.#plan.dataDir;
		if (dir === null) {
			return '';
		}
		let names: string[];
		try {
			const all = await readdir(dir);
			const extensions = this.#plan.extensions;
			names = all
				.filter((n) => extensions.some((e) => n.toLowerCase().endsWith(e)))
				.filter((n) => !/\.d\.m?ts$/i.test(n))
				.toSorted();
		} catch {
			return 'unreadable';
		}
		const stamps = await Promise.all(names.map((n) => stampOf(path.join(dir, n))));
		return names.map((n, i) => `${n}:${stamps[i]}`).join('|');
	}

	async #stampsOf(files: readonly string[]): Promise<FileStamp[]> {
		return Promise.all(files.map(async (f) => ({ path: f, stamp: await stampOf(f) })));
	}

	async #toDisk(module: DataModule, state: State): Promise<void> {
		if (state.value === undefined) {
			return;
		}
		const entry: CacheEntry = {
			version: 1,
			value: state.value.value,
			reads: state.reads,
			sources: state.sources,
			ranAt: state.ranAt,
			maxAge: state.maxAge,
		};
		const file = this.#cacheFile(module.key);
		try {
			await mkdir(path.dirname(file), { recursive: true });
			// A temporary file and a rename: a server that starts while a build writes must not
			// read half a file.
			const temporary = `${file}.${process.pid}.tmp`;
			await writeFile(temporary, JSON.stringify(entry));
			await rename(temporary, file);
		} catch {
			// The cache is an optimisation; a directory that cannot be written costs a run.
		}
	}
}
