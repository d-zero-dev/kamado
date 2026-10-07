/**
 * The entry of a render worker: renders the chunks of jobs that the main
 * thread sends and posts the HTML back. See `renderJobs` in `render.ts`.
 */
import type { RenderContext } from './props.js';

import { parentPort, workerData } from 'node:worker_threads';

import { createRenderer, type RenderJob } from './render.js';

const data = workerData as { context: RenderContext; runtimeUrl: string };
const port = parentPort;
if (!port) {
	throw new Error('render-worker.js is a worker entry; it cannot be run directly');
}

const renderOne = await createRenderer(data.context, data.runtimeUrl);

port.on('message', (message: { jobs: readonly RenderJob[] }) => {
	void (async () => {
		try {
			const results = [];
			for (const job of message.jobs) {
				results.push(await renderOne(job));
			}
			port.postMessage({ results });
		} catch (error) {
			port.postMessage({ error: error instanceof Error ? error.message : String(error) });
		}
	})();
});
port.postMessage({ ready: true });
