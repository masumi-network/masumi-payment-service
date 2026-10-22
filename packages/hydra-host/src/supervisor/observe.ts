/**
 * Observation: probe one node and persist what the probe saw.
 *
 * Split out of the supervisor so the reconciler only plans and acts; these
 * take the state they need explicitly, the same way `unwedgeRecord` does.
 */

import type { HostConfig } from '../config.js';
import type { NodeClient } from '../node-client.js';
import type { NodeRegistryStore } from '../registry/store.js';
import type { NodeRecord } from '../registry/types.js';
import { classifyDrift, driftBreachFields, measureDrift, resolveDriftThresholds, type SlotConfig } from './drift.js';
import { muteFields } from './mute.js';
import { shouldAdoptAsRunning, type NodeObservation } from './plan.js';
import { isProcessRunningNode, type NodeProcessManager } from './process.js';
import { earnsStartBudgetRefund } from './start-budget.js';
import type { SupervisorLogger } from './supervisor.js';

export type ObserveNodeDeps = {
	client: Pick<NodeClient, 'isResponsive' | 'probeChain'>;
	processes: Pick<NodeProcessManager, 'isRunning'>;
	store: Pick<NodeRegistryStore, 'nodeDir'>;
	config: Pick<HostConfig, 'hydraNodeBin' | 'drift'>;
	slotConfig: SlotConfig;
};

export async function observeNode(record: NodeRecord, deps: ObserveNodeDeps): Promise<NodeObservation> {
	const { client } = deps;
	if (!deps.processes.isRunning(record.nodeId)) {
		// Not a child of THIS host does not mean not running. A host restart
		// leaves its nodes serving but loses the handles to them, so judging by
		// the child table alone would mark a live node dead one tick after boot
		// adopted it — and keep doing so on every tick after that.
		if (!(await client.isResponsive())) {
			// One slow probe is not evidence that the process is gone, and the
			// action taken on that evidence is a spawn: a second hydra-node over
			// the first one's persistence directory, api port and etcd data dir.
			// A recorded pid that is still running hydra-node settles it — the
			// node is up and merely busy, which is exactly how an owned child is
			// already treated one branch below.
			const alive =
				record.pid !== undefined &&
				(await isProcessRunningNode(record.pid, deps.config.hydraNodeBin, deps.store.nodeDir(record.nodeId)));
			return {
				processRunning: alive,
				drift: null,
				driftSeconds: null,
				responsive: false,
				chainSynced: false,
				nowMs: Date.now(),
			};
		}
	} else if (!(await client.isResponsive())) {
		return {
			processRunning: true,
			drift: null,
			driftSeconds: null,
			responsive: false,
			chainSynced: false,
			nowMs: Date.now(),
		};
	}

	const chain = await client.probeChain();
	// Measured whenever the node reports a slot, in sync or not. Drift on a
	// synced node is a warning; drift on a catching-up node is the whole
	// diagnosis, and computing it only for the former left operators staring
	// at "still catching up" with no way to tell minutes from days.
	const slot = chain.slot;
	let drift: NodeObservation['drift'] = null;
	let driftSeconds: number | null = null;
	if (slot !== null) {
		// Validate against THIS node's unsynced period, not the host default: a
		// node provisioned with a shorter period needs a guard that still fires
		// before the node starts refusing input.
		const thresholds = resolveDriftThresholds(record.unsyncedPeriodSeconds * 1000, deps.config.drift);
		const sample = measureDrift(slot, deps.slotConfig, Date.now());
		driftSeconds = Math.round(sample.driftMs / 1000);
		// Judged whether or not the node says it is in sync.
		//
		// It used to be judged only when the node reported InSync, to avoid
		// restarting one that was legitimately catching up. That reasoning
		// assumed catching up always ends. With the Blockfrost backend it does
		// not: the delay-free catch-up loop runs once at startup, and the poll
		// loop it then enters sleeps a whole average block time before every
		// block, so a node that falls behind reports `CatchingUp` forever and
		// was never judged, never restarted, and never recovered.
		//
		// Telling "catching up" from "stuck" is not this verdict's job — both
		// look identical in one sample. The plan decides, on whether the gap is
		// closing across ticks.
		drift = classifyDrift(sample, thresholds);
	}

	return {
		processRunning: true,
		drift,
		driftSeconds,
		responsive: true,
		chainSynced: chain.synced,
		nowMs: Date.now(),
	};
}

export type RecordObservationDeps = {
	store: Pick<NodeRegistryStore, 'update'>;
	logger: SupervisorLogger;
};

/**
 * Persist what the probe saw, and promote a node that has come up.
 *
 * Three things depend on this being durable rather than in-memory:
 *
 *  - the health endpoint, which is the payment service's only way to ask
 *    whether a node is usable, and which otherwise reports a record that
 *    says `Running` for a node whose API is dead;
 *  - `Starting` → `Running`, so `Running` means "answering" rather than
 *    "spawned" — with two participants a node legitimately sits in
 *    `Starting` for minutes, since etcd has no quorum until both are up;
 *  - the restart budget, which must be refunded once a node proves it can
 *    stay up, or routine drift restarts accumulate until a healthy node is
 *    marked Failed.
 *
 * Written every tick, including when only the timestamp changed: a stale
 * `checkedAt` is itself the signal that the supervisor has stopped ticking,
 * and that is worth more than the write it saves.
 */
export async function recordObservation(
	record: NodeRecord,
	observation: NodeObservation,
	deps: RecordObservationDeps,
): Promise<NodeRecord> {
	const { store, logger } = deps;
	const earnedBudget = earnsStartBudgetRefund(observation);
	const promote = shouldAdoptAsRunning(record, observation);
	// A node this host did not spawn has no exit handler, so its death is not
	// reported by anything — it simply stops being in `processes`. Left at
	// that, the next tick starts it again with `lastStopUndrained` false and
	// the unwedge check is skipped for exactly the nodes that survived a host
	// restart, which are the ones most likely to be carrying a stranded round.
	// This is the same conclusion `onExit` draws for an owned child.
	const diedUnobserved =
		!observation.processRunning &&
		!observation.responsive &&
		(record.state === 'Running' || record.state === 'Starting');

	const updated = await store.update(record.nodeId, (current) => ({
		...current,
		lastObservation: {
			checkedAt: new Date(observation.nowMs).toISOString(),
			responsive: observation.responsive,
			chainSynced: observation.chainSynced,
			drift: observation.drift,
			driftSeconds: observation.driftSeconds,
		},
		...driftBreachFields(current, observation),
		...muteFields(current, observation),
		// The reason goes with the state. It is written by six paths and was cleared
		// by none, so a node that failed its start budget, was fixed and came back
		// reported `state: Running, usable: true` alongside the failure it recovered
		// from — for good, and the next incident is read through it.
		...(promote && shouldAdoptAsRunning(current, observation)
			? { state: 'Running' as const, failureReason: undefined }
			: {}),
		...(earnedBudget && current.startAttempts !== 0 ? { startAttempts: 0 } : {}),
		...(diedUnobserved && (current.state === 'Running' || current.state === 'Starting')
			? { state: 'Stopped' as const, lastStopUndrained: true, pid: undefined }
			: {}),
	}));

	if (diedUnobserved && updated?.state === 'Stopped') {
		logger.warn(`[supervisor] ${record.nodeId} is gone and nothing recorded its exit; treating as an undrained stop`);
	}

	if (promote && updated?.state === 'Running' && record.state !== 'Running') {
		logger.info(
			`[supervisor] ${record.nodeId} is answering its API${record.state === 'Stopped' ? ' despite being recorded as stopped; adopting it' : ''}`,
		);
	}
	return updated ?? record;
}
