/**
 * Teardown: drain-then-stop a node, and remove one for good.
 *
 * Split out of the supervisor so the reconciler only plans and acts; these
 * take the state they need explicitly, the same way `unwedgeRecord` does.
 */

import type { HostConfig } from '../config.js';
import type { NodeClient } from '../node-client.js';
import type { PortAllocator } from '../registry/ports.js';
import type { NodeRegistryStore } from '../registry/store.js';
import type { NodeRecord } from '../registry/types.js';
import { sleep } from './concurrency.js';
import { drainReader, waitForDrain } from './drain.js';
import type { NodeProcessManager } from './process.js';
import type { SupervisorLogger } from './supervisor.js';

const SIGKILL_GRACE_MS = 30_000;

export type StopNodeDeps = {
	client: NodeClient;
	processes: Pick<NodeProcessManager, 'isRunning' | 'stop'>;
	store: Pick<NodeRegistryStore, 'update'>;
	config: Pick<HostConfig, 'drainTimeoutMs'>;
	logger: SupervisorLogger;
	adoptProcess: (record: NodeRecord) => Promise<boolean>;
};

/**
 * Take a node down.
 *
 * Returns whether it is actually down afterwards. A stop can fail — a node
 * that answers but that this host cannot signal is recorded `Failed` and left
 * running — and a caller that goes on to start it spawns a second hydra-node
 * over the first one's persistence directory, api port and etcd data dir.
 */
export async function stopNode(record: NodeRecord, reason: string, deps: StopNodeDeps): Promise<boolean> {
	const { client, processes, store, config, logger } = deps;
	if (!processes.isRunning(record.nodeId)) {
		// A node this host restarted away from is still stoppable by pid.
		await deps.adoptProcess(record);
	}
	if (!processes.isRunning(record.nodeId)) {
		// Nothing to signal. This used to return as though the stop had
		// succeeded, which left `desired: Stopped` permanently unreachable: the
		// plan asked for a stop every tick, the stop did nothing, and the record
		// went on saying Running while the payment service kept routing work to
		// a node the operator had asked to take down.
		if (await client.isResponsive()) {
			const failureReason =
				'the node is answering but this host holds no way to signal it, so it cannot be stopped or restarted here; ' +
				'stop the process on the machine, then start or remove the node again';
			logger.error(`[supervisor] cannot stop ${record.nodeId} (${reason}): ${failureReason}`);
			await store.update(record.nodeId, (current) => ({ ...current, state: 'Failed', failureReason }));
			return false;
		}
		// Genuinely down, and nothing drained it.
		await store.update(record.nodeId, (current) => ({
			...current,
			state: 'Stopped',
			lastStopUndrained: true,
			pid: undefined,
		}));
		return true;
	}
	logger.info(`[supervisor] draining ${record.nodeId} before stop: ${reason}`);
	await store.update(record.nodeId, (current) => ({ ...current, state: 'Draining' }));

	const outcome = await waitForDrain({
		fetchLastSeen: drainReader(client),
		timeoutMs: config.drainTimeoutMs,
		pollIntervalMs: 2_000,
		sleep,
		now: () => Date.now(),
	});

	// The drain is only reached with a live process — checked above — so an
	// unreachable node here is not a node that has exited, it is a node that
	// has stopped answering while still running: a wedged event loop, a hung
	// etcd client, a round left in flight. That is the exact case the unwedge
	// check exists for, and taking `drained` at face value recorded it as a
	// clean stop and skipped the check on the way back up.
	const wedged = outcome.reason === 'unreachable';
	if (wedged) {
		logger.warn(
			`[supervisor] ${record.nodeId} stopped answering while its process was still running; ` +
				'stopping it as an undrained stop and will check for a stranded round on restart',
		);
	} else if (!outcome.drained) {
		logger.warn(
			`[supervisor] ${record.nodeId} did not drain within ${config.drainTimeoutMs}ms ` +
				`(last tag ${String(outcome.lastTag)}); stopping anyway and will check for a stranded round on restart`,
		);
	}

	const stopResult = await processes.stop(record.nodeId, SIGKILL_GRACE_MS);
	if (!stopResult.graceful) {
		logger.warn(`[supervisor] ${record.nodeId} required SIGKILL`);
	}

	// A process that outlived SIGKILL is still holding this node's persistence
	// directory, its api port and its peer port. Reporting it stopped is what
	// let `remove` delete those files and hand the port to the next provision
	// while the orphan kept writing to both. The pid is kept for the same
	// reason: it is the only handle anything has on it.
	if (!stopResult.stopped) {
		const failureReason = `the process (pid ${String(record.pid ?? 'unknown')}) did not exit on SIGKILL, so its files and ports are still in use`;
		logger.error(`[supervisor] ${record.nodeId} could not be stopped: ${failureReason}`);
		await store.update(record.nodeId, (current) => ({
			...current,
			state: 'Failed',
			lastStopUndrained: true,
			failureReason,
		}));
		return false;
	}

	const undrained = !outcome.drained || wedged || !stopResult.graceful;
	await store.update(record.nodeId, (current) => ({
		...current,
		state: 'Stopped',
		lastStopUndrained: undrained,
		pid: undefined,
	}));
	return true;
}

export type RemoveNodeDeps = {
	client: Pick<NodeClient, 'isResponsive'>;
	clients: Map<string, NodeClient>;
	store: Pick<NodeRegistryStore, 'update' | 'remove'>;
	ports: Pick<PortAllocator, 'release'>;
	logger: SupervisorLogger;
	stop: (record: NodeRecord, reason: string) => Promise<boolean>;
};

export async function removeNode(record: NodeRecord, reason: string, deps: RemoveNodeDeps): Promise<void> {
	const { store, logger } = deps;
	logger.info(`[supervisor] removing ${record.nodeId}: ${reason}`);
	// The intent is written down BEFORE anything destroys the state it was
	// derived from. `stop` writes `Draining` and then `Stopped` over whatever
	// the record said, and the planner reads the state to decide what to do
	// next — so a host killed between the stop and `store.remove` resumed a
	// node it was in the middle of deleting.
	//
	// `requestRemoval` sets this on the API path for exactly that reason. The
	// planner-initiated removals did not, and the escrow one is the case that
	// bites: an expired `PendingEscrow` node whose state is overwritten by the
	// stop can never match the `PendingEscrow` reaper again, so it settles into
	// `Idle` forever holding its peer port, its persistence directory and the
	// signing keys of a node the payment service never acknowledged — the exact
	// orphan the escrow design exists to prevent.
	const doomed =
		record.removalRequested === true
			? record
			: ((await store.update(record.nodeId, (current) => ({ ...current, removalRequested: true }))) ?? record);
	// Unconditionally, because "not a child of this host" is not the same as
	// "not running": `stop` takes the process back by pid when it can, and says
	// so when it cannot.
	const stopped = await deps.stop(doomed, reason);

	// A node that still answers is one the stop could not reach. Deleting its
	// persistence directory out from under it and handing its peer port to the
	// next node turns one stuck node into two: the orphan keeps writing and
	// keeps the port bound, and the node that inherits the port cannot start.
	//
	// The stop's own answer is checked alongside the probe, because the case
	// this guard exists for is precisely a node that has stopped answering
	// while its process runs on: a wedged node fails `isResponsive` and would
	// have passed straight through.
	if (!stopped || (await deps.client.isResponsive())) {
		const failureReason = stopped
			? 'the node is still answering after a stop attempt, so its files and peer port are still in use; ' +
				'stop the process on the machine, then remove the node again'
			: 'the process did not exit on SIGKILL, so its files and peer port are still in use; ' +
				'stop the process on the machine, then remove the node again';
		logger.error(`[supervisor] refusing to remove ${record.nodeId}: ${failureReason}`);
		// The intent is cleared with the failure. Left set, the plan asks for the
		// same removal on every tick, it is refused for the same reason every
		// time, and the log fills with a failure nobody is being asked to act on.
		await store.update(record.nodeId, (current) => ({
			...current,
			state: 'Failed',
			removalRequested: false,
			failureReason,
		}));
		return;
	}

	try {
		await store.remove(record.nodeId);
	} catch (error) {
		// The record is still on disk, and it still carries this peer port. So
		// the port is NOT free: releasing it hands the same number to the next
		// provision, and the next boot — which rebuilds the allocator from the
		// records on disk — claims it twice and throws `PortLayoutError` out of
		// `main()`, crash-looping a host that supervises nothing until someone
		// deletes the directory by hand.
		const failureReason =
			`the node directory could not be deleted (${(error as Error).message}), so its port and files are still in use; ` +
			'remove the node again once the volume is writable';
		logger.error(`[supervisor] removing ${record.nodeId} failed: ${failureReason}`);
		await store.update(record.nodeId, (current) => ({
			...current,
			state: 'Failed',
			removalRequested: false,
			failureReason,
		}));
		return;
	}
	deps.ports.release(record.peerPort);
	deps.clients.delete(record.nodeId);
}
