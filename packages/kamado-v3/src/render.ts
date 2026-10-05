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
	/** The compiled module of the page (`null` for an `.html` page). */
	readonly main: string | null;
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
				const main = await loadComponent(job.main, 'a page');
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
}

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
		return out;
	}
	const workerCount = Math.min(parallelism, Math.ceil(jobs.length / 8));
	const chunk = options.chunk ?? 16;
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
						results.push(...message.results);
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
