/**
 * Shutdown drain: find every node a SIGTERM has to take down, and stop them all at once.
 *
 * Split out of the supervisor so the reconciler only plans and acts; these
 * take the state they need explicitly, the same way `unwedgeRecord` does.
 */

import type { NodeRegistryStore } from '../registry/store.js';
import type { NodeRecord } from '../registry/types.js';
import { mapWithConcurrency, sleep } from './concurrency.js';
import { mayStillBeRunning } from './plan.js';
import { isProcessAlive, type NodeProcessManager } from './process.js';
import type { SupervisorLogger } from './supervisor.js';

export type ShutdownDrainDeps = {
	store: Pick<NodeRegistryStore, 'list' | 'read'>;
	processes: Pick<NodeProcessManager, 'isRunning' | 'list'>;
	/** The tick's per-node claim set, shared so the two never act on one node at once. */
	inFlight: Set<string>;
	logger: SupervisorLogger;
	stop: (record: NodeRecord, reason: string) => Promise<boolean>;
};

/**
 * The records a shutdown has to work through, however damaged the store is.
 *
 * `list()` fails wholesale: one unparseable `node.json`, or one I/O error off
 * the data volume, and it throws for every node. Catching that stopped SIGTERM
 * from becoming a hard kill — `shutdown` no longer rejected — but it drained
 * nothing either, on both passes, and then `index.ts` logged "all nodes
 * drained" and exited 0 while the runtime SIGKILLed a fleet mid-round. A clean
 * log for the exact outcome the drain machinery exists to prevent.
 *
 * So the fall-back asks the one source that cannot be corrupted by a file: the
 * live child handles this host is holding. Each record is then read on its
 * own, which skips only the node that is actually damaged.
 */
export async function listRecordsToDrain(deps: ShutdownDrainDeps): Promise<NodeRecord[]> {
	const { store, logger } = deps;
	try {
		return await store.list();
	} catch (error) {
		logger.error(
			`[supervisor] could not list nodes to drain: ${(error as Error).message}; falling back to the running processes`,
		);
	}
	const recovered: NodeRecord[] = [];
	for (const running of deps.processes.list()) {
		try {
			const record = await store.read(running.nodeId);
			if (record !== null) recovered.push(record);
			else logger.error(`[supervisor] ${running.nodeId} is running with no readable record; leaving it to the runtime`);
		} catch (error) {
			logger.error(
				`[supervisor] could not read ${running.nodeId} to drain it: ${(error as Error).message}; leaving it to the runtime`,
			);
		}
	}
	logger.info(`[supervisor] recovered ${recovered.length} running node record(s) to drain`);
	return recovered;
}

/**
 * Every node drains at once, not RECONCILE_CONCURRENCY at a time.
 *
 * Shutdown is one round of waiting, not work: a node costs drainTimeoutMs
 * (120s) plus SIGKILL_GRACE_MS (30s) plus SIGKILL_WAIT_MS (5s) = 155s worst
 * case, almost all of it idle. Batching them at 8 made the worst case
 * `ceil(nodes / 8) x 155s`, so a host at its default capacity of 32 needed
 * 620s — and `SHUTDOWN_GRACE_MS` hard-exits the process at 240s. Past the
 * first batch SIGTERM never finished: the runtime killed the remaining
 * hydra-nodes mid-round and every one of them came back `lastStopUndrained`,
 * each carrying an unwedge check and a possibly stranded round.
 *
 * Raising the compose grace does not help while the host kills itself first,
 * so the fan-out is what has to change. The reconcile path keeps its limit:
 * that one really is work, and it runs every 15s.
 */
export async function drainRunningNodes(attempted: Set<string>, deps: ShutdownDrainDeps): Promise<void> {
	const { store, processes, inFlight, logger } = deps;
	const records = await listRecordsToDrain(deps);
	await mapWithConcurrency(records, Math.max(1, records.length), async (record) => {
		if (attempted.has(record.nodeId)) {
			// Already stopped, or tried and failed — a second SIGTERM would
			// overwrite the Failed reason `stop` just recorded with `Draining`.
			return;
		}
		// Waited out, not skipped. Skipping deferred the node to the pass after
		// `await pendingTick`, which made the two passes ADDITIVE: a tick
		// holding one node in an observe or an unwedge cost a full drain round
		// before that node's own drain even started — measured at two rounds,
		// which at the real budget is 310s against the 240s SHUTDOWN_GRACE_MS.
		// Waiting here costs only the tick's own hold, and every other node
		// drains through its own worker meanwhile.
		//
		// Deliberately unbounded: the tick's work is bounded by the same
		// timeouts this is, and the grace period is the backstop. A bound would
		// only reintroduce the deferral it exists to remove.
		while (inFlight.has(record.nodeId)) {
			await sleep(100);
		}
		// Re-read after that wait. The tick may have stopped this node while we
		// waited, and the record read before the wait still says it was Draining.
		const current = (await store.read(record.nodeId).catch(() => null)) ?? record;
		// Not `isRunning` alone: that answers "do I hold a handle?", and a node this
		// host lost the handle to — SIGTERM before boot adopted it, an entry
		// `revalidateAdopted` dropped — is still a running process. `stop` re-adopts
		// by pid, so reaching it is what drains that node.
		if (
			!processes.isRunning(current.nodeId) &&
			!mayStillBeRunning(current, current.pid !== undefined && isProcessAlive(current.pid))
		) {
			return;
		}
		// Same claim the tick makes, and taken the same way — checked and set
		// with no await in between, so exactly one of the two owns the node.
		// Without it a node could be sent SIGTERM twice and have two drains
		// racing on its record.
		if (inFlight.has(record.nodeId)) {
			return;
		}
		inFlight.add(record.nodeId);
		attempted.add(record.nodeId);
		try {
			await deps.stop(current, 'host shutting down');
		} catch (error) {
			logger.error(`[supervisor] stopping ${record.nodeId} failed: ${(error as Error).message}`);
		} finally {
			inFlight.delete(record.nodeId);
		}
	});
}
