/**
 * The KZG accumulator, computed on a worker thread.
 *
 * History replay recomputes the accumulator over a head's whole UTxO set for
 * every signed snapshot. On the event loop that is seconds per frame for a busy
 * head, back to back, and nothing else in the process runs meanwhile: database
 * pool connects time out and every request and job fails with them. On a
 * worker the main thread only waits.
 *
 * One worker serves every head; requests queue in it. If the worker cannot be
 * started at all, the computation falls back to the event loop — slower for
 * the process, but a head that replays slowly is better than one that cannot
 * replay.
 */
import { Worker } from 'node:worker_threads';

import { logger } from '@masumi/payment-core/logger';
import { HydraProtocolError, HydraTransportError } from './errors';
import { computeHydraAccumulatorHash } from './snapshot-accumulator';

/** Computes the accumulator hash of serialized outputs, synchronously or not. */
export type HydraAccumulatorComputer = (serializedOutputs: string[]) => string | Promise<string>;

/**
 * Generous: a maximum-size snapshot (4095 outputs) takes a few seconds on a
 * developer machine. A worker that answers nothing for this long while it
 * holds requests is wedged, not busy. Measured from its last answer, not from
 * when a request was sent: the worker answers in order, and a request queued
 * behind other heads' snapshots is waiting, not stuck.
 */
const ACCUMULATOR_WORKER_TIMEOUT_MS = 120_000;

type AccumulatorReply = { id: number; hash?: string; error?: string };
type PendingRequest = {
	outputs: string[];
	resolve: (hash: string) => void;
	reject: (error: Error) => void;
};
/** One started worker and the requests only it can answer. */
type WorkerSlot = {
	worker: Worker;
	pending: Map<number, PendingRequest>;
	hasReplied: boolean;
	watchdog: NodeJS.Timeout | undefined;
};

/**
 * The worker entry, resolved against this module's own location. Under `tsx`
 * this module is `src/lib/hydra/hydra/*.ts`; in the build it is bundled into
 * `dist/`, where the entry is emitted beside it.
 */
function accumulatorWorkerUrl(): URL {
	return import.meta.url.endsWith('.ts')
		? new URL('../../../hydra-accumulator-worker.ts', import.meta.url)
		: new URL('./hydra-accumulator-worker.js', import.meta.url);
}

function settleInProcess(request: PendingRequest): void {
	try {
		request.resolve(computeHydraAccumulatorHash(request.outputs));
	} catch (error) {
		request.reject(error instanceof Error ? error : new HydraProtocolError(String(error)));
	}
}

function rejectAll(slot: WorkerSlot, error: Error): void {
	clearTimeout(slot.watchdog);
	slot.watchdog = undefined;
	for (const request of slot.pending.values()) request.reject(error);
	slot.pending.clear();
}

export function createWorkerAccumulatorComputer(
	createWorker: () => Worker = () => new Worker(accumulatorWorkerUrl()),
): HydraAccumulatorComputer {
	let current: WorkerSlot | undefined;
	let workerUnavailable = false;
	let nextRequestId = 0;

	const retire = (slot: WorkerSlot) => {
		if (current === slot) current = undefined;
		void slot.worker.terminate().catch(() => undefined);
	};

	/** (Re)arm the slot's watchdog while it holds requests; disarm it otherwise. */
	const watch = (slot: WorkerSlot) => {
		clearTimeout(slot.watchdog);
		slot.watchdog = undefined;
		if (slot.pending.size === 0) return;
		slot.watchdog = setTimeout(() => {
			// Wedged: every later request would wait behind it, so retire the
			// worker and fail what it still holds. The next request starts afresh.
			retire(slot);
			rejectAll(
				slot,
				new HydraTransportError(`Hydra accumulator worker answered nothing for ${ACCUMULATOR_WORKER_TIMEOUT_MS}ms`),
			);
		}, ACCUMULATOR_WORKER_TIMEOUT_MS);
		slot.watchdog.unref();
	};

	const markUnavailable = (error: unknown) => {
		workerUnavailable = true;
		logger.error('[HydraNode] KZG accumulator worker could not start; computing on the event loop', { error });
	};

	const startWorker = (): WorkerSlot | undefined => {
		if (current) return current;
		if (workerUnavailable) return undefined;
		let worker: Worker;
		try {
			worker = createWorker();
		} catch (error) {
			markUnavailable(error);
			return undefined;
		}
		const slot: WorkerSlot = { worker, pending: new Map(), hasReplied: false, watchdog: undefined };
		worker.unref();
		worker.on('message', ({ id, hash, error }: AccumulatorReply) => {
			slot.hasReplied = true;
			const request = slot.pending.get(id);
			if (!request) return;
			slot.pending.delete(id);
			watch(slot);
			if (hash !== undefined) request.resolve(hash);
			else request.reject(new HydraProtocolError(error ?? 'Hydra accumulator worker returned no result'));
		});
		worker.on('error', (error) => {
			retire(slot);
			if (!slot.hasReplied) {
				// Failing before its first reply means the entry itself cannot load (a
				// missing build file, a broken loader): it never will, so stop trying
				// and answer what was already asked on the event loop.
				markUnavailable(error);
				clearTimeout(slot.watchdog);
				for (const request of slot.pending.values()) settleInProcess(request);
				slot.pending.clear();
				return;
			}
			rejectAll(slot, new HydraTransportError('Hydra accumulator worker failed', { cause: error }));
		});
		worker.on('exit', (code) => {
			retire(slot);
			rejectAll(slot, new HydraTransportError(`Hydra accumulator worker exited with code ${code}`));
		});
		current = slot;
		return slot;
	};

	return (serializedOutputs) => {
		const slot = startWorker();
		if (!slot) return computeHydraAccumulatorHash(serializedOutputs);
		const id = nextRequestId++;
		return new Promise<string>((resolve, reject) => {
			slot.pending.set(id, { outputs: serializedOutputs, resolve, reject });
			if (slot.pending.size === 1) watch(slot);
			slot.worker.postMessage({ id, outputs: serializedOutputs });
		});
	};
}
