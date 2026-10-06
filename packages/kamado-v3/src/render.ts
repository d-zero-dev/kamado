/**
 * Rendering the pages that the core hands over: JSX pages (a compiled
 * module) and pages with a layout. Everything here runs in Node; the core
 * did the planning, and takes the HTML back for its own stages.
 *
 * Components must be pure: workers render pages in parallel and share
 * nothing, so a component that changes module state gives results that
 * depend on scheduling.
 */
import { availableParallelism } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { createProps, type RenderContext } from './props.js';

/** What the core asks for one page. */
export interface RenderJob {
	/** Index into `context.pages`. */
	readonly page: number;
	/**
	 * The compiled module of the page (`null` for an `.html` page). With
	 * `entry` it is a chunk that holds several pages.
	 */
	readonly main: string | null;
	/** The position of the page in the chunk `main` (`pages[entry]()` gives its exports). */
	readonly entry?: number | null;
	/** The compiled module of the layout, if the page names one. */
	readonly layout: string | null;
	/** The body of an `.html` page: what its layout wraps. */
	readonly content: string | null;
}

/** The HTML for a page: `[page index, html]`. */
export type Rendered = readonly [number, string];

type Component = (props: Record<string, unknown>) => unknown;
type Render = (component: Component, props: Record<string, unknown>) => string;

interface RuntimeModule {
	readonly render: Render;
}

/** The pages of a chunk: each one a function that gives the exports of the page. */
type Chunk = readonly (() => Promise<{ default?: unknown }>)[];

/** Chunks are loaded once per worker; a chunk holds the pages of a batch of jobs. */
const chunks = new Map<string, Promise<Chunk>>();

/**
 * Loads the default export (the component) of a page: a function of a chunk
 * or a compiled module.
 * @param job - What the core asked for
 */
async function loadPage(job: RenderJob & { readonly main: string }): Promise<Component> {
	if (job.entry === undefined || job.entry === null) {
		return await loadComponent(job.main, 'a page');
	}
	let chunk = chunks.get(job.main);
	if (!chunk) {
		chunk = import(pathToFileURL(job.main).href).then((m: { pages: Chunk }) => m.pages);
		chunks.set(job.main, chunk);
	}
	const pages = await chunk;
	const run = pages[job.entry];
	if (!run) {
		throw new Error(`the chunk ${job.main} has no page ${job.entry}`);
	}
	const exports = await run();
	if (typeof exports.default !== 'function') {
		throw new TypeError(`a page must export a component as default: ${job.main}`);
	}
	return exports.default as Component;
}

/**
 * Loads the default export (the component) of a compiled module.
 * @param file - Absolute path of the compiled module
 * @param what - What the module is, for the error message
 */
async function loadComponent(file: string, what: string): Promise<Component> {
	const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
	if (typeof mod.default !== 'function') {
		throw new TypeError(`${what} must export a component as default: ${file}`);
	}
	return mod.default as Component;
}

/**
 * Creates the function that renders one job.
 * @param context - Site, data and the page list
 * @param runtimeUrl - File URL of the JSX runtime
 * @example
 * ```ts
 * const renderOne = await createRenderer(context, runtimeUrl);
 * const [page, html] = await renderOne(job);
 * ```
 */
export async function createRenderer(
	context: RenderContext,
	runtimeUrl: string,
): Promise<(job: RenderJob) => Promise<Rendered>> {
	const { render } = (await import(runtimeUrl)) as RuntimeModule;
	return async (job) => {
		const page = context.pages[job.page];
		if (!page) {
			throw new Error(`the core asked for page ${job.page}, which does not exist`);
		}
		try {
			let html: string;
			if (job.main) {
				const main = await loadPage({ ...job, main: job.main });
				html = render(main, createProps(context, job.page));
			} else {
				html = job.content ?? '';
			}
			if (job.layout) {
				const layout = await loadComponent(job.layout, 'a layout');
				html = render(layout, createProps(context, job.page, { content: html }));
			}
			return [job.page, html];
		} catch (error) {
			throw new Error(`Failed to render ${page.inputPath}: ${messageOf(error)}`, {
				cause: error,
			});
		}
	};
}

/**
 * The text of a thrown value.
 * @param error - Anything that was thrown
 */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Options of {@link renderJobs}. */
export interface RenderOptions {
	/** File URL of the JSX runtime. */
	readonly runtimeUrl: string;
	/** Number of workers (default: the machine's parallelism). */
	readonly parallelism?: number;
	/** Jobs per message to a worker. */
	readonly chunk?: number;
	/**
	 * Called with the pages of each batch as soon as it is rendered. When it is
	 * given, `renderJobs` keeps nothing and returns an empty list: a site of
	 * tens of thousands of pages is not held in memory twice.
	 */
	readonly onRendered?: (rendered: readonly Rendered[]) => void;
}

/**
 * Jobs per message to a worker. The core puts this many consecutive pages into
 * one chunk file (`CHUNK_PAGES` in `kd_core::session`), so a worker loads one
 * file per message.
 */
const RENDER_BATCH = 64;

/** Fewer jobs than this are rendered in the main thread: workers cost more to start. */
const INLINE_BELOW = 24;

/**
 * Renders every job, in worker threads when there are enough of them.
 * @param jobs - What the core asked for
 * @param context - Site, data and the page list
 * @param options - Runtime and parallelism
 * @returns The HTML per page
 * @example
 * ```ts
 * const rendered = await renderJobs(prepared.jobs, prepared.context, { runtimeUrl });
 * ```
 */
export async function renderJobs(
	jobs: readonly RenderJob[],
	context: RenderContext,
	options: RenderOptions,
): Promise<Rendered[]> {
	const parallelism = Math.max(1, options.parallelism ?? availableParallelism());
	if (parallelism === 1 || jobs.length < INLINE_BELOW) {
		const renderOne = await createRenderer(context, options.runtimeUrl);
		const out: Rendered[] = [];
		for (const job of jobs) {
			out.push(await renderOne(job));
		}
		if (options.onRendered) {
			options.onRendered(out);
			return [];
		}
		return out;
	}
	const chunk = options.chunk ?? RENDER_BATCH;
	// A batch is the unit of work: no more workers than batches.
	const workerCount = Math.min(parallelism, Math.ceil(jobs.length / chunk));
	return await new Promise<Rendered[]>((resolve, reject) => {
		const results: Rendered[] = [];
		const workers: Worker[] = [];
		// Workers that were told to stop: their exit is not a failure.
		const finished = new Set<Worker>();
		let next = 0;
		let running = 0;
		let failed = false;
		const stop = (error?: unknown) => {
			if (failed) {
				return;
			}
			if (error !== undefined) {
				failed = true;
				for (const worker of workers) {
					void worker.terminate();
				}
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		};
		const dispatch = (worker: Worker) => {
			if (next >= jobs.length) {
				finished.add(worker);
				void worker.terminate();
				running--;
				if (running === 0 && !failed) {
					resolve(results);
				}
				return;
			}
			worker.postMessage({ jobs: jobs.slice(next, next + chunk) });
			next += chunk;
		};
		for (let i = 0; i < workerCount; i++) {
			const worker = new Worker(new URL('render-worker.js', import.meta.url), {
				workerData: { context, runtimeUrl: options.runtimeUrl },
			});
			workers.push(worker);
			running++;
			worker.on(
				'message',
				(message: { results?: Rendered[]; error?: string; ready?: true }) => {
					if (message.error !== undefined) {
						stop(new Error(message.error));
						return;
					}
					if (message.results) {
						if (options.onRendered) {
							options.onRendered(message.results);
						} else {
							results.push(...message.results);
						}
					}
					dispatch(worker);
				},
			);
			worker.on('error', stop);
			worker.on('exit', (code) => {
				if (code !== 0 && !failed && !finished.has(worker)) {
					stop(new Error(`a render worker exited with code ${code}`));
				}
			});
		}
	});
}
