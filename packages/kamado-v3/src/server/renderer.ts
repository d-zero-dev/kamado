import type { RenderContext } from '../props.js';
import type { RenderJob } from '../render.js';
import type { ContextUpdate } from './context-update.js';

import { Worker } from 'node:worker_threads';

/** One worker and the renders it still owes. */
interface Slot {
	readonly worker: Worker;
	readonly waiting: Map<
		number,
		{ resolve: (html: string) => void; reject: (error: Error) => void }
	>;
	retired: boolean;
}

/**
 * Renders the pages of the dev server in a worker thread that can be started
 * again. Node cannot unload a module, so when a component changed the worker
 * is replaced by a fresh one with the whole context; a worker that was
 * replaced finishes the renders it was given and then stops.
 *
 * Calls are ordered: what is sent first is seen first, so the caller may
 * send an update and then a job without waiting in between.
 * @example
 * ```ts
 * const renderer = new ServeRenderer(runtimeUrl);
 * renderer.start(context);
 * const html = await renderer.render(job);
 * ```
 */
export class ServeRenderer {
	#nextId = 1;
	readonly #runtimeUrl: string;
	#slot: Slot | undefined;

	/** Whether a worker is running (it has a context). */
	get started(): boolean {
		return this.#slot !== undefined;
	}
	/**
	 * @param runtimeUrl - File URL of the JSX runtime
	 */
	constructor(runtimeUrl: string) {
		this.#runtimeUrl = runtimeUrl;
	}

	/** Stops the worker and whatever it still owes. */
	async close(): Promise<void> {
		const slot = this.#slot;
		this.#slot = undefined;
		if (slot) {
			for (const entry of slot.waiting.values()) {
				entry.reject(new Error('the renderer was closed'));
			}
			slot.waiting.clear();
			await slot.worker.terminate();
		}
	}
	/**
	 * Renders one job.
	 * @param job - What the core asked for
	 * @returns The HTML of the page
	 * @throws {Error} with the message of the failure in the worker
	 */
	render(job: RenderJob): Promise<string> {
		const slot = this.#slot;
		if (!slot) {
			return Promise.reject(new Error('the renderer was not started'));
		}
		const id = this.#nextId++;
		return new Promise<string>((resolve, reject) => {
			slot.waiting.set(id, { resolve, reject });
			slot.worker.postMessage({ type: 'render', id, job });
		});
	}
	/**
	 * Starts a fresh worker with the whole context; the one that ran so far
	 * finishes its renders and stops.
	 * @param context - Site, data and the page list
	 */
	start(context: RenderContext): void {
		if (this.#slot) {
			this.#retire(this.#slot);
		}
		const worker = new Worker(new URL('serve-worker.js', import.meta.url), {
			workerData: { context, runtimeUrl: this.#runtimeUrl },
		});
		const slot: Slot = { worker, waiting: new Map(), retired: false };
		worker.on('message', (message: { id: number; html?: string; error?: string }) => {
			const entry = slot.waiting.get(message.id);
			slot.waiting.delete(message.id);
			if (message.error === undefined) {
				entry?.resolve(message.html ?? '');
			} else {
				entry?.reject(new Error(message.error));
			}
			this.#stopWhenDone(slot);
		});
		worker.on('error', (error) => {
			for (const entry of slot.waiting.values()) {
				entry.reject(error);
			}
			slot.waiting.clear();
			if (this.#slot === slot) {
				this.#slot = undefined;
			}
		});
		this.#slot = slot;
	}

	/**
	 * Tells the worker what changed in the context.
	 * @param update - The core's report
	 */
	update(update: ContextUpdate): void {
		this.#slot?.worker.postMessage({ type: 'update', update });
	}

	#retire(slot: Slot): void {
		slot.retired = true;
		this.#stopWhenDone(slot);
	}

	#stopWhenDone(slot: Slot): void {
		if (slot.retired && slot.waiting.size === 0) {
			void slot.worker.terminate();
		}
	}
}
