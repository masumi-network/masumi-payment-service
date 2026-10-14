/**
 * Worker-thread entry for the Hydra KZG accumulator.
 *
 * A separate build entry (see `exports` in package.json) so the bundle emits it
 * as its own file next to `dist/index.js`. It loads nothing but the accumulator:
 * the request is serialized outputs, the reply is the commitment hash or the
 * error message the main thread re-raises.
 */
import { parentPort } from 'node:worker_threads';

import { computeHydraAccumulatorHash } from './lib/hydra/hydra/snapshot-accumulator';

type AccumulatorRequest = { id: number; outputs: string[] };

// Reached only once every import above has loaded: the main thread treats a
// failure before this as an entry that can never load, and one after it as a
// worker that can be replaced.
parentPort?.postMessage({ ready: true });

parentPort?.on('message', ({ id, outputs }: AccumulatorRequest) => {
	try {
		parentPort?.postMessage({ id, hash: computeHydraAccumulatorHash(outputs) });
	} catch (error) {
		parentPort?.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
	}
});
