/**
 * The entry of the dev server's render worker: holds the context the core
 * sent and renders one job at a time. See `ServeRenderer`.
 *
 * Why a worker and not the main thread: Node cannot unload a module, so a
 * changed component is only seen by a fresh thread with a fresh module cache.
 */
import type { RenderContext } from '../props.js';

import { parentPort, workerData } from 'node:worker_threads';

import { createRenderer, type RenderJob } from '../render.js';

import { applyUpdate, type ContextUpdate } from './context-update.js';

type Message =
	| { readonly type: 'update'; readonly update: ContextUpdate }
	| { readonly type: 'render'; readonly id: number; readonly job: RenderJob };

const port = parentPort;
if (!port) {
	throw new Error('serve-worker.js is a worker entry; it cannot be run directly');
}
const runtimeUrl = (workerData as { runtimeUrl: string }).runtimeUrl;
let context = (workerData as { context: RenderContext }).context;

// Messages are handled in the order they came, also when a handler awaits.
let queue: Promise<void> = Promise.resolve();

port.on('message', (message: Message) => {
	queue = queue.then(async () => {
		if (message.type === 'update') {
			context = applyUpdate(context, message.update);
			return;
		}
		try {
			const renderOne = await createRenderer(context, runtimeUrl);
			const [, html] = await renderOne(message.job);
			port.postMessage({ id: message.id, html });
		} catch (error) {
			port.postMessage({
				id: message.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});
});
